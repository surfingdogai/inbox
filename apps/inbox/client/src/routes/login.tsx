import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Sun } from "../components/Feedback";
import { api, problemOf } from "../lib/api";
import { isSignedIn, KEY_PREFIX, signIn } from "../lib/auth";
import { useBusiness } from "../lib/queries";

interface LoginSearch {
  readonly redirect?: string;
  readonly reason?: "expired";
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    ...(typeof search.redirect === "string" && search.redirect.startsWith("/") ? { redirect: search.redirect } : {}),
    ...(search.reason === "expired" ? { reason: "expired" as const } : {}),
  }),
  beforeLoad: ({ search }) => {
    if (isSignedIn()) throw redirect({ href: search.redirect ?? "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const { redirect: back, reason } = Route.useSearch();
  const navigate = useNavigate();
  const business = useBusiness();
  const [key, setKey] = useState("");
  const [touched, setTouched] = useState(false);
  const verify = useMutation({
    mutationFn: (k: string) => api.verifyKey(k),
    onSuccess: (_settings, k) => {
      signIn(k);
      void navigate({ href: back ?? "/", replace: true });
    },
  });

  const trimmed = key.trim();
  const local = !trimmed
    ? "Paste the key first."
    : !trimmed.startsWith(KEY_PREFIX)
      ? `Owner keys start with ${KEY_PREFIX}. Agent keys cannot open the inbox.`
      : null;
  const remote = verify.error ? problemOf(verify.error) : null;
  const remoteText =
    remote &&
    (remote.status === 401
      ? "That key was not accepted. Check it was copied whole and has not been revoked."
      : remote.detail);
  const shown = (touched && local) || remoteText || null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!local) verify.mutate(trimmed);
  };

  return (
    <main className="page page-center">
      <form className="login glass-strong" onSubmit={submit}>
        <Sun size="sm" />
        <h1>{business.data?.name ? `Sign in to ${business.data.name}` : "Sign in"}</h1>
        <p className="lede">Paste your owner API key. Passkeys and email links come later.</p>
        {reason === "expired" && (
          <p className="hint error" role="alert">
            Your key was refused, so you were signed out. Paste it again, or a new one.
          </p>
        )}
        <div>
          <label className="label" htmlFor="owner-key">
            Owner API key
          </label>
          <input
            id="owner-key"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${KEY_PREFIX}…`}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              verify.reset();
            }}
            aria-invalid={shown ? "true" : undefined}
            aria-describedby="owner-key-hint"
          />
          <div id="owner-key-hint" className={clsx("hint", shown && "error")} aria-live="polite">
            {shown ?? "The key stays in this browser only."}
          </div>
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={verify.isPending}>
          {verify.isPending ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <KeyRound className="icon" aria-hidden="true" />
          )}
          Sign in
        </button>
      </form>
    </main>
  );
}
