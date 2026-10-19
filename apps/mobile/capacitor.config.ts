import type { CapacitorConfig } from "@capacitor/cli";

/**
 * One app for both stores (ADR-026): the screens are bundled in it (`dist`), never a website loaded
 * from somewhere. The app talks to each inbox it is connected to over https, by native HTTP (no
 * browser origin, so no CORS to open on an inbox), with that inbox's own tokens.
 */
const config: CapacitorConfig = {
  appId: "ai.surfingdog.inbox",
  appName: "Surfing Dog Inbox",
  webDir: "dist",
  android: {
    // Screens are served to the WebView from https://localhost inside the app; nothing is fetched to show them.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: { androidScheme: "https" },
  plugins: {
    // fetch and XMLHttpRequest go out natively: an inbox never sees a browser origin from the app.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
