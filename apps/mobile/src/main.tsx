import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, defaultDeps } from "./App";
import "./app.css";

async function start() {
  let deps = defaultDeps();
  // Development only: a made-up inbox for the screenshots and for trying the screens without a server.
  // Left out of the app's own build.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) {
    const { demoDeps } = await import("./demo");
    deps = await demoDeps(new URLSearchParams(location.search));
  }
  const root = document.getElementById("root");
  if (root)
    createRoot(root).render(
      <StrictMode>
        <App deps={deps} />
      </StrictMode>,
    );
}

void start();
