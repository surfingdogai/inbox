import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { inboxOrigin, type PhoneLink } from "../../../../packages/core/src/phones/links";
import { useApp } from "../context";
import type { Granted, GrantedInbox, PendingSignIn } from "../lib/account";
import { lockWords } from "../lib/native";
import { type Scanner, startScanner } from "../lib/scan";
import { findInbox, type PendingPhone } from "../lib/session";
import { ChevronLeft, Corners } from "./icons";

/** How often the phone asks whether its yes came, and for how long: the computer's, or the other phone's. */
const ASK_EVERY_MS = 2_000;
const WAIT_MS = 5 * 60_000;
const PHONE_WAIT_MS = 15 * 60_000;

/**
 * Connect your inbox (the approved Connect screen): scan the code in Settings → Phone, nothing to
 * type. The phone first says which inbox the code is for and asks to connect to it; then it shows two
 * digits and waits for the owner to press Confirm on the computer, where the same two show.
 *
 * Or sign in with email (ADR-028 Amendment 4), with no computer: an inbox Surfing Dog hosts gets a
 * code from Surfing Dog, by email at any provider, and the app connects it. When the owner already has
 * a confirmed phone, that phone says yes to this one, with the same two digits on both, or this one
 * waits a day. An inbox on the owner's own server sends its own sign-in link, found from the address.
 */
export function Connect({
  canGoBack,
  allowLocal,
  handed,
  onHandled,
  code,
  onCode,
  start,
}: {
  canGoBack: boolean;
  allowLocal: boolean;
  /** A code the page a QR code opens handed to the app (`intent://pair…`). */
  handed?: PhoneLink | null;
  onHandled?: () => void;
  /** A code the sign-in email's button handed to the app (`ai.surfingdog.inbox://code?…`). */
  code?: { id: string; code: string } | null;
  onCode?: () => void;
  /** Where the screen opens: the camera, or signing in with email. */
  start?: "scan" | "email" | undefined;
}) {
  const app = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<Scanner | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [byEmail, setByEmail] = useState(start === "email" || Boolean(code));
  const [asking, setAsking] = useState<PhoneLink | null>(null);
  const [pending, setPending] = useState<PendingPhone | null>(null);
  const [secure, setSecure] = useState(true);
  const [noOtherPhone, setNoOtherPhone] = useState(false);

  useEffect(() => () => scanner.current?.stop(), []);
  useEffect(() => {
    void app.native
      .deviceSecure()
      .then(setSecure)
      .catch(() => undefined);
  }, [app.native]);
  useEffect(() => {
    if (!handed) return;
    setAsking(handed);
    onHandled?.();
  }, [handed, onHandled]);
  useEffect(() => {
    if (code) setByEmail(true);
  }, [code]);

  // Waiting for the yes: the owner's Confirm on the computer, asked every two seconds for five
  // minutes, or on the owner's other phone, for fifteen.
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const onPhone = pending.waitsOn === "phone";
    const until = Date.now() + (onPhone ? PHONE_WAIT_MS : WAIT_MS);
    const ask = async () => {
      if (!alive) return;
      const state = await app.sessions.confirmed(pending);
      if (!alive) return;
      if (state === "confirmed") {
        const entry = await app.sessions.finish(pending);
        setPending(null);
        await app.connected(entry);
        return;
      }
      if (state === "refused" || Date.now() > until) {
        await app.sessions.abandon(pending);
        setPending(null);
        setByEmail(false);
        setError(
          onPhone
            ? "Not connected. Sign in again, and confirm on your other phone."
            : "Not connected. On your computer, show a new code and scan it again.",
        );
        return;
      }
      setTimeout(() => void ask(), ASK_EVERY_MS);
    };
    void ask();
    return () => {
      alive = false;
    };
  }, [pending, app]);

  /** "Wait 24 hours": this phone is kept, opening nothing, until its day is over or it is stopped. */
  const waitADay = async (p: PendingPhone) => {
    setBusy(true);
    setError(null);
    try {
      const entry = await app.sessions.waitADay(p);
      setPending(null);
      setNoOtherPhone(false);
      await app.connected(entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const pair = async (link: PhoneLink) => {
    setAsking(null);
    setBusy(true);
    setError(null);
    try {
      if (link.kind === "pair") setPending(await app.sessions.pair(link));
      else await app.connected(await app.sessions.redeem(link));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Show a new code and try again.");
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setError(null);
    if (!video.current) return;
    try {
      setScanning(true);
      scanner.current = await startScanner(
        video.current,
        (link) => {
          setScanning(false);
          // Which inbox the code is for, before anything is sent to it.
          if (link.kind === "pair") setAsking(link);
          else void pair(link);
        },
        allowLocal,
      );
    } catch {
      setScanning(false);
      setError("The camera did not start. Allow the camera for this app, or use a sign-in link instead.");
    }
  };

  if (pending?.waitsOn === "phone")
    return (
      <div className="connect screen">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1>{noOtherPhone ? "Wait a day instead?" : "Confirm on your other phone"}</h1>
          {noOtherPhone ? (
            <p>
              This phone then connects to {new URL(pending.origin).host} in 24 hours. Your other phones and your email
              are told meanwhile, so it can be stopped if it isn't you. Until then it opens nothing.
            </p>
          ) : (
            <p>
              Open Surfing Dog Inbox on the phone you already use. It asks whether this phone may connect to{" "}
              {new URL(pending.origin).host}, with two digits. Confirm there if they are these:
            </p>
          )}
        </div>
        {!noOtherPhone && <div className="match">{pending.match}</div>}
        {!noOtherPhone && <p className="fine">Waiting for your other phone…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="end">
          {noOtherPhone ? (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void waitADay(pending)}>
                Wait 24 hours
              </button>
              <button type="button" className="btn quiet" onClick={() => setNoOtherPhone(false)}>
                Back
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setNoOtherPhone(true)}>
                I don't have my other phone
              </button>
              <button
                type="button"
                className="btn quiet"
                onClick={() => {
                  void app.sessions.abandon(pending);
                  setPending(null);
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    );

  if (byEmail && !pending)
    return (
      <SignIn
        onBack={() => setByEmail(false)}
        handed={code ?? null}
        onHandled={onCode}
        onPending={(p) => {
          setError(null);
          setPending(p);
        }}
      />
    );

  if (pending)
    return (
      <div className="connect screen">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1>Confirm on your computer</h1>
          <p>
            Your computer shows <b>{app.native.platform === "web" ? "this browser" : "this phone"}</b> asking to connect
            to {new URL(pending.origin).host}, with two digits. Press Confirm there if they are these:
          </p>
        </div>
        <div className="match">{pending.match}</div>
        <p className="fine">Waiting for you to confirm…</p>
        <div className="end">
          <button
            type="button"
            className="btn quiet"
            onClick={() => {
              void app.sessions.abandon(pending);
              setPending(null);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );

  if (asking)
    return (
      <div className="connect screen">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1>Connect to {new URL(asking.origin).host}?</h1>
          <p>This phone will open that inbox and answer it. Connect only to your own business's inbox.</p>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="end">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void pair(asking)}>
            Connect
          </button>
          <button type="button" className="btn quiet" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div className="connect screen">
      {canGoBack && (
        <button type="button" className="back" onClick={() => app.go({ name: "inboxes" })}>
          <ChevronLeft />
          Your inboxes
        </button>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h1>Connect your inbox</h1>
        <p>On your computer, open your inbox, go to Settings, then Phone. Point your camera at the code.</p>
      </div>
      <div className="frame">
        <video ref={video} muted playsInline style={{ display: scanning ? "block" : "none" }} />
        <Corners />
        {!scanning && <span className="hint">{busy ? "Connecting…" : "The code appears here"}</span>}
      </div>
      <ol className="steps">
        <li>
          <b>1</b>Scan the code. Nothing to type.
        </li>
        <li>
          <b>2</b>Allow notifications for new requests.
        </li>
      </ol>
      {!secure && (
        <p className="error" role="alert">
          Set a {lockWords(app.native.platform).noun} first. Your inbox opens only on a phone with{" "}
          {lockWords(app.native.platform).kinds}.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="end">
        {scanning ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              scanner.current?.stop();
              setScanning(false);
            }}
          >
            Stop the camera
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy || !secure} onClick={() => void scan()}>
            Scan the code
          </button>
        )}
        <button type="button" className="btn quiet" disabled={!secure} onClick={() => setByEmail(true)}>
          Sign in with email instead
        </button>
        {/* No inbox yet: a look round the demo shop first (lib/client.ts → DemoClient), no lock needed. */}
        {!canGoBack && (
          <button type="button" className="btn quiet" onClick={app.tryDemo}>
            Try the demo
          </button>
        )}
        <p className="fine">
          Your inbox, on your own server or hosted by Surfing Dog.
          <br />
          This app opens it on your phone.
        </p>
      </div>
    </div>
  );
}

/** What an inbox the service lists says when it takes no new phone now. */
function notNow(state: string): string {
  if (state === "suspended") return "Paused for now";
  if (state === "closing") return "Closing";
  if (state === "setup") return "Still being set up";
  return "Can't connect a phone now";
}

/** "Send a new code (0:45)": seconds left before another code may be asked for. */
function secondsLeft(started: PendingSignIn, now: number): number {
  return Math.max(0, Math.ceil((started.sentAt + started.resendIn * 1000 - now) / 1000));
}

/**
 * Sign in with email (Amendment 4): the address the owner signs in with, then the code Surfing Dog
 * emails when an inbox it hosts is theirs. The email's button opens the app with the code; typing it
 * is the fallback, for an email read on another device. An inbox on the owner's own server is
 * reached after, by the sign-in link it sends itself.
 */
function SignIn({
  onBack,
  handed,
  onHandled,
  onPending,
}: {
  onBack: () => void;
  handed: { id: string; code: string } | null;
  onHandled?: (() => void) | undefined;
  onPending: (pending: PendingPhone) => void;
}) {
  const app = useApp();
  const [step, setStep] = useState<"email" | "code" | "choose" | "own">("email");
  const [email, setEmail] = useState("");
  const [started, setStarted] = useState<PendingSignIn | null>(null);
  const [typed, setTyped] = useState("");
  const [granted, setGranted] = useState<Granted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const connect = useCallback(
    async (g: Granted, inbox: GrantedInbox) => {
      const r = await app.sessions.connectHosted(app.account, g.grant, inbox);
      if ("entry" in r) await app.connected(r.entry);
      else onPending(r.pending);
    },
    [app, onPending],
  );

  const confirm = useCallback(
    async (code: string, id?: string) => {
      setBusy(true);
      setError(null);
      let g: Granted | null = null;
      try {
        g = await app.account.confirm(code, id);
        const open = g.inboxes.filter((i) => i.can_connect);
        if (g.inboxes.length === 1 && open[0]) await connect(g, open[0]);
        else {
          setGranted(g);
          setStep("choose");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "That did not work. Try again.");
        // The code was taken: what is left to do is choose the inbox again, or sign in again.
        if (g) {
          setGranted(g);
          setStep("choose");
        }
      } finally {
        setBusy(false);
      }
    },
    [app, connect],
  );

  // A sign-in this phone started before the app was closed (the email took a while): picked up.
  useEffect(() => {
    let alive = true;
    void app.account.pending().then((p) => {
      if (alive && p) {
        setStarted(p);
        setStep("code");
      }
    });
    return () => {
      alive = false;
    };
  }, [app.account]);

  // The email's button: its code goes in for the sign-in this phone started, and for no other. Once.
  const took = useRef<string | null>(null);
  useEffect(() => {
    if (!handed || took.current === `${handed.id}:${handed.code}`) return;
    took.current = `${handed.id}:${handed.code}`;
    onHandled?.();
    setStep("code");
    void confirm(handed.code, handed.id);
  }, [handed, onHandled, confirm]);

  useEffect(() => {
    if (step !== "code") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStarted(await app.account.start(email));
      setTyped("");
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const again = async () => {
    setError(null);
    try {
      setStarted(await app.account.resend());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    }
  };

  const restart = async () => {
    await app.account.forget();
    setStarted(null);
    setGranted(null);
    setTyped("");
    setError(null);
    setStep("email");
  };

  if (step === "own") return <OwnServer email={email} onBack={() => setStep(started ? "code" : "email")} />;

  const header = (
    <button type="button" className="back" onClick={step === "email" ? onBack : () => void restart()}>
      <ChevronLeft />
      Back
    </button>
  );
  const problem = error && (
    <p className="error" role="alert">
      {error}
    </p>
  );

  if (step === "choose" && granted)
    return (
      <div className="connect screen">
        {header}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1>Which inbox?</h1>
          <p>Choose the inbox to open on this phone. You can add the others after.</p>
        </div>
        <div className="group">
          <div className="rows">
            {granted.inboxes.map((i) => (
              <div key={i.id}>
                <span className="two">
                  <span>{i.name}</span>
                  <small>{i.can_connect ? new URL(i.origin).host : notNow(i.state)}</small>
                </span>
                <button
                  type="button"
                  className="btn link"
                  disabled={busy || !i.can_connect}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void connect(granted, i)
                      .catch((e) => setError(e instanceof Error ? e.message : "That did not work."))
                      .finally(() => setBusy(false));
                  }}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        </div>
        {granted.inboxes.length === 0 && <p>No inbox of yours can open on a phone yet.</p>}
        {problem}
      </div>
    );

  if (step === "code" && started) {
    const wait = secondsLeft(started, now);
    return (
      <div className="connect screen">
        {header}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1>Check your email</h1>
          <p>
            Open the email we sent to {started.to || "your address"} and tap <b>Open in the app</b>.
          </p>
        </div>
        <form
          className="group"
          style={{ gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void confirm(typed);
          }}
        >
          <label className="stacked">
            <span>Reading it on another device? Type its code:</span>
            <span className="field">
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                maxLength={7}
                value={typed}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 6);
                  setTyped(v);
                  if (v.length === 6 && !busy) void confirm(v);
                }}
                aria-label="The code from the email"
              />
            </span>
          </label>
          {problem}
          <button type="submit" className="btn primary" disabled={busy || typed.length !== 6}>
            {busy ? "Connecting…" : "Continue"}
          </button>
        </form>
        <div className="end">
          <button type="button" className="btn quiet" disabled={wait > 0} onClick={() => void again()}>
            {wait > 0
              ? `Send a new code (${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")})`
              : "Send a new code"}
          </button>
          <button type="button" className="btn quiet" onClick={() => void restart()}>
            Wrong email?
          </button>
          <p className="fine">
            No email? If your inbox is on your own server,{" "}
            <button type="button" className="btn link" onClick={() => setStep("own")}>
              get a link from it instead
            </button>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="connect screen">
      {header}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h1>Sign in with email</h1>
        <p>We'll send a code to the address you sign in to your inbox with.</p>
      </div>
      <form className="group" onSubmit={(e) => void send(e)} style={{ gap: 12 }}>
        <label className="stacked">
          <span>Your email</span>
          <span className="field">
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourbusiness.com"
            />
          </span>
        </label>
        {problem}
        <button type="submit" className="btn primary" disabled={busy}>
          Send my code
        </button>
      </form>
    </div>
  );
}

/**
 * An inbox on the owner's own server: the app finds it from the address's domain (asking for the
 * inbox's address only when it cannot) and asks it for a sign-in link, which only this phone can
 * redeem.
 */
function OwnServer({ email: first, onBack }: { email: string; onBack: () => void }) {
  const app = useApp();
  const [email, setEmail] = useState(first);
  const [address, setAddress] = useState("");
  const [needAddress, setNeedAddress] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let origin = needAddress ? inboxOrigin(address.includes("://") ? address : `https://${address}`) : null;
      if (!origin) origin = await findInbox(email, (i, init) => fetch(i, init));
      if (!origin) {
        setNeedAddress(true);
        setError(needAddress ? "That address does not look right." : null);
        return;
      }
      setSent(await app.sessions.askForLink(origin, email.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect screen">
      <button type="button" className="back" onClick={onBack}>
        <ChevronLeft />
        Back
      </button>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h1>Your own server</h1>
        <p>Your inbox sends a link to the address you sign in to it with. Open it on this phone.</p>
      </div>
      {sent ? (
        <p role="status">{sent}</p>
      ) : (
        <form className="group" onSubmit={(e) => void submit(e)} style={{ gap: 12 }}>
          <label className="stacked">
            <span>Your email</span>
            <span className="field">
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbusiness.com"
              />
            </span>
          </label>
          {needAddress && (
            <label className="stacked">
              <span>Your inbox's address</span>
              <span className="field">
                <input
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  required
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="inbox.yourbusiness.com"
                />
              </span>
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={busy}>
            Send me a link
          </button>
        </form>
      )}
    </div>
  );
}
