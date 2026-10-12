import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { KeyRound, Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Sun } from "../components/Feedback";
import { api, problemOf } from "../lib/api";
import { ensureSignedIn, forgetSession, KEY_PREFIX, sameSitePath, signInWithKey } from "../lib/auth";
import { useBusiness } from "../lib/queries";

interface LoginSearch {
  readonly redirect?: string;
  readonly reason?: "expired";
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const back = sameSitePath(search.redirect);
    return {
      ...(back ? { redirect: back } : {}),
      ...(search.reason === "expired" ? { reason: "expired" as const } : {}),
    };
  },
  beforeLoad: async ({ search }) => {
    if (await ensureSignedIn()) throw redirect({ href: search.redirect ?? "/" });
  },
  component: LoginPage,
});

type Mode = "email" | "sent" | "key";

/**
 * Sign in by email first: the server mails a link, whose page sets the session cookie, and a code
 * to type here instead, for an email read on another device. An owner API key is the other way in,
 * for people who only ever use the API.
 */
function LoginPage() {
  const { redirect: back, reason } = Route.useSearch();
  const business = useBusiness();
  const [mode, setMode] = useState<Mode>("email");
  const [unsent, setUnsent] = useState(false);
  const name = business.data?.name;
  const title = name ? `Sign in to ${name}` : "Sign in";

  return (
    <main className="page page-center">
      <div className="login glass-strong">
        <Sun size="sm" />
        {mode === "sent" ? (
          <SentState back={back} unsent={unsent} onAnother={() => setMode("email")} />
        ) : mode === "key" ? (
          <KeyForm title={title} back={back} reason={reason} onEmail={() => setMode("email")} />
        ) : (
          <EmailForm
            title={title}
            back={back}
            reason={reason}
            onSent={(failed) => {
              setUnsent(failed);
              setMode("sent");
            }}
            onKey={() => setMode("key")}
          />
        )}
      </div>
    </main>
  );
}

let lastEmail = "";

function EmailForm({
  title,
  back,
  reason,
  onSent,
  onKey,
}: {
  title: string;
  back: string | undefined;
  reason: "expired" | undefined;
  /** `failed`: the email could not be sent, and the next screen says so. */
  onSent: (failed: boolean) => void;
  onKey: () => void;
}) {
  const [email, setEmail] = useState(lastEmail);
  const [touched, setTouched] = useState(false);
  const request = useMutation({
    mutationFn: (address: string) => api.requestMagicLink(address, back),
    onSuccess: (_r, address) => {
      lastEmail = address;
      onSent(false);
    },
    // Couldn't send: an earlier email's code may still work, so the code field is shown anyway.
    onError: (e, address) => {
      if (problemOf(e).code !== "mail_failed") return;
      lastEmail = address;
      onSent(true);
    },
  });
  const trimmed = email.trim().toLowerCase();
  const local = !trimmed
    ? "Enter the email address you use for this inbox."
    : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)
      ? "That does not look like an email address."
      : null;
  const remote = request.error ? problemOf(request.error).detail : null;
  const shown = (touched && local) || remote || null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!local) request.mutate(trimmed);
  };

  return (
    <form className="stack" onSubmit={submit}>
      <h1>{title}</h1>
      <p className="lede">We email you a link and a code to open the inbox. No password to remember.</p>
      {reason === "expired" && (
        <p className="hint error" role="alert">
          You were signed out: the session ended or the key was refused. Sign in again.
        </p>
      )}
      <div>
        <label className="label" htmlFor="login-email">
          Email
        </label>
        <input
          id="login-email"
          className="input"
          type="email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            request.reset();
          }}
          aria-invalid={shown ? "true" : undefined}
          aria-describedby="login-email-hint"
        />
        <div id="login-email-hint" className={clsx("hint", shown && "error")} aria-live="polite">
          {shown ?? "Only addresses added to this inbox get an email."}
        </div>
      </div>
      <button type="submit" className="btn btn-primary btn-lg" disabled={request.isPending}>
        {request.isPending ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <Mail className="icon" aria-hidden="true" />
        )}
        Send me a sign-in email
      </button>
      <div className="hr" />
      <button type="button" className="btn btn-ghost" onClick={onKey}>
        <KeyRound className="icon" aria-hidden="true" />
        Use an API key instead
      </button>
    </form>
  );
}

function SentState({ back, unsent, onAnother }: { back: string | undefined; unsent: boolean; onAnother: () => void }) {
  const [code, setCode] = useState("");
  const again = useMutation({ mutationFn: () => api.requestMagicLink(lastEmail, back) });
  const enter = useMutation({
    mutationFn: (typed: string) => api.signInWithCode(lastEmail, typed),
    // A full load: the app starts again signed in, and a page outside the app (an AI app's consent) opens as itself.
    onSuccess: () => {
      forgetSession();
      window.location.assign(back ?? "/");
    },
  });
  const failed =
    !again.isSuccess && (unsent || (again.error !== null && problemOf(again.error).code === "mail_failed"));
  const problem = enter.error
    ? problemOf(enter.error).detail
    : again.error && !failed
      ? problemOf(again.error).detail
      : null;
  const typed = code.replace(/\s+/g, "");
  return (
    <form
      className="stack"
      aria-live="polite"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^[0-9]{6}$/.test(typed)) enter.mutate(typed);
      }}
    >
      <h1>Check your email</h1>
      {failed ? (
        <p className="hint error" role="alert">
          Couldn't send. Send it again in a minute, or use the code from an earlier email.
        </p>
      ) : (
        <p className="lede">
          If <b>{lastEmail}</b> belongs to this inbox, a sign-in email is on its way. Open its link, or type its code
          here. Both work for 15 minutes.
        </p>
      )}
      <div>
        <label className="label" htmlFor="login-code">
          Code
        </label>
        <input
          id="login-code"
          className="input"
          autoComplete="one-time-code"
          inputMode="numeric"
          spellCheck={false}
          maxLength={7}
          placeholder="123456"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            enter.reset();
          }}
          aria-invalid={enter.error ? "true" : undefined}
          aria-describedby="login-code-hint"
        />
        <div id="login-code-hint" className={clsx("hint", problem && "error")}>
          {problem ??
            "Nothing there? Look in spam, or ask the owner to add your address. If this inbox can't send email yet, the email is in the server's log instead. On Cloudflare, that's your Worker's logs in the dashboard."}
        </div>
      </div>
      <button type="submit" className="btn btn-primary btn-lg" disabled={enter.isPending || !/^[0-9]{6}$/.test(typed)}>
        {enter.isPending ? <span className="spinner" aria-hidden="true" /> : null}
        Sign in
      </button>
      <div className="rowx">
        <button type="button" className="btn btn-secondary" onClick={onAnother}>
          Use another address
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => again.mutate()} disabled={again.isPending}>
          {again.isSuccess ? "Sent again" : "Send it again"}
        </button>
      </div>
    </form>
  );
}

function KeyForm({
  title,
  back,
  reason,
  onEmail,
}: {
  title: string;
  back: string | undefined;
  reason: "expired" | undefined;
  onEmail: () => void;
}) {
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [touched, setTouched] = useState(false);
  const verify = useMutation({
    mutationFn: (k: string) => api.verifyKey(k),
    onSuccess: (_settings, k) => {
      signInWithKey(k);
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
    <form className="stack" onSubmit={submit}>
      <h1>{title}</h1>
      <p className="lede">Paste an owner API key. It stays in this browser only.</p>
      {reason === "expired" && (
        <p className="hint error" role="alert">
          You were signed out: the session ended or the key was refused. Sign in again.
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
          {shown ?? "Make one in Settings → Keys once you're signed in, or with create-owner-key on your own server."}
        </div>
      </div>
      <button type="submit" className="btn btn-primary btn-lg" disabled={verify.isPending}>
        {verify.isPending ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <KeyRound className="icon" aria-hidden="true" />
        )}
        Sign in with the key
      </button>
      <div className="hr" />
      <button type="button" className="btn btn-ghost" onClick={onEmail}>
        <Mail className="icon" aria-hidden="true" />
        Send me a sign-in email instead
      </button>
    </form>
  );
}
