import "@fontsource-variable/manrope";
import "@fontsource-variable/plus-jakarta-sans";
import "./app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiProblem, setUnauthorizedHandler } from "./lib/api";
import { dropCredentials } from "./lib/auth";
import { initTheme } from "./lib/theme";
import { routeTree } from "./routeTree.gen";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // A refusal the API explains (4xx) will not change on retry; a network blip might.
      retry: (count, error) => !(error instanceof ApiProblem && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// A refused owner call means the session ended or the key was revoked: forget both, ask again.
setUnauthorizedHandler(() => {
  dropCredentials();
  const redirect = `${window.location.pathname}${window.location.search}`;
  void router.navigate({ to: "/login", search: { reason: "expired", ...(redirect !== "/" ? { redirect } : {}) } });
});

initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
