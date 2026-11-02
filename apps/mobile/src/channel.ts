/**
 * Which copy of the app this is (store/play/signing.md). Two are published from the same code:
 *
 * - `direct`, the APK on surfingdog.ai/phone: it says when a new version is ready there
 *   (lib/update.ts) and opens the page for it. This file is that copy's.
 * - `play`, the bundle for Google Play: Play installs and updates it, and an app from Play may update
 *   only through Play (Device and Network Abuse policy). `vite build --mode play` puts
 *   `channel.play.ts` in this file's place (vite.config.ts), so that build carries no update check and
 *   no link to the download page at all, rather than one switched off.
 */
export const CHANNEL: "direct" | "play" = "direct";
export { checkForUpdate } from "./lib/update";
export { UpdateLine } from "./screens/Update";
