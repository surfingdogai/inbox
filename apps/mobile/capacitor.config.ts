import type { CapacitorConfig } from "@capacitor/cli";

/**
 * One app for both stores (ADR-028): the screens are bundled in it (`dist`), never a website loaded
 * from somewhere. The app talks to each inbox it is connected to over https, by native HTTP (no
 * browser origin, so no CORS to open on an inbox), with that inbox's own tokens.
 *
 * iPhone: the same screens and the same settings, with the Keychain and the Secure Enclave where
 * Android has the Keystore, and APNs behind the same relay (IOS.md).
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
  ios: {
    // The owner app's ground behind the screens while they load, as on Android.
    backgroundColor: "#f6f5ff",
    // The screens lay themselves out around the notch and the home bar (env(safe-area-inset-*)).
    contentInset: "never",
    preferredContentMode: "mobile",
    // A long press on a link shows no preview of a page: the app opens only its own screens.
    allowsLinkPreview: false,
    // Never inspectable from a computer, a release or not, as on Android.
    webContentsDebuggingEnabled: false,
    loggingBehavior: "none",
  },
  // capacitor://localhost on iPhone, https://localhost on Android. Pinned: the screens' storage lives
  // under that origin, so changing it later would lose what the app keeps.
  server: { androidScheme: "https", iosScheme: "capacitor" },
  plugins: {
    // fetch and XMLHttpRequest go out natively: an inbox never sees a browser origin from the app.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
