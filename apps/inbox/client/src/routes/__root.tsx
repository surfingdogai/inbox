import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, type ErrorComponentProps, Link, Outlet } from "@tanstack/react-router";
import { Sky } from "../components/Sky";

export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function Root() {
  return (
    <div className="shell">
      <Sky />
      <Outlet />
    </div>
  );
}

function NotFound() {
  return (
    <main className="page page-center">
      <div className="card glass-strong state">
        <h2>There is nothing at this address</h2>
        <p>Check the link, or go back to the inbox.</p>
        <Link to="/" className="btn btn-primary">
          Open the inbox
        </Link>
      </div>
    </main>
  );
}

function RootError({ error, reset }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <main className="page page-center">
      <div className="card glass-strong state" role="alert">
        <h2>Something went wrong on this screen</h2>
        <p>{message}</p>
        <div className="rowx center">
          <button type="button" className="btn btn-primary" onClick={reset}>
            Try again
          </button>
          <Link to="/" className="btn btn-secondary">
            Open the inbox
          </Link>
        </div>
      </div>
    </main>
  );
}
