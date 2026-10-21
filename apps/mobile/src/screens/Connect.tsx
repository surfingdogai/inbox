import { type FormEvent, useEffect, useRef, useState } from "react";
import { inboxOrigin, type PhoneLink } from "../../../../packages/core/src/phones/links";
import { useApp } from "../context";
import { type Scanner, startScanner } from "../lib/scan";
import { findInbox, type PendingPhone } from "../lib/session";
import { ChevronLeft, Corners } from "./icons";

/** How often the phone asks whether the owner pressed Confirm, and for how long. */
const ASK_EVERY_MS = 2_000;
const WAIT_MS = 5 * 60_000;

/**
 * Connect your inbox (the approved Connect screen): scan the code in Settings → Phone, nothing to
 * type. The phone first says which inbox the code is for and asks to connect to it; then it shows two
 * digits and waits for the owner to press Confirm on the computer, where the same two show. Without a
 * camera, a sign-in link by email: the owner types the address they sign in with, and the app finds
 * the inbox from its domain, asking for the inbox's address only when it cannot.
 */
export function Connect({
  canGoBack,
  allowLocal,
  handed,
  onHandled,
}: {
  canGoBack: boolean;
  allowLocal: boolean;
  /** A code the page a QR code opens handed to the app (`intent://pair…`). */
  handed?: PhoneLink | null;
  onHandled?: () => void;
}) {
  const app = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<Scanner | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [byEmail, setByEmail] = useState(false);
  const [asking, setAsking] = useState<PhoneLink | null>(null);
  const [pending, setPending] = useState<PendingPhone | null>(null);
  const [secure, setSecure] = useState(true);

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

  // Waiting for the owner's Confirm on the computer: asked every two seconds, for five minutes.
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const until = Date.now() + WAIT_MS;
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
        setError("Not connected. On your computer, show a new code and scan it again.");
        return;
      }
      setTimeout(() => void ask(), ASK_EVERY_MS);
    };
    void ask();
    return () => {
      alive = false;
    };
  }, [pending, app]);

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

  if (byEmail) return <ByEmail onBack={() => setByEmail(false)} />;

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
          Set a screen lock first. Your inbox opens only on a phone with a PIN, pattern or password.
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
          Email me a sign-in link instead
        </button>
        <p className="fine">
          Your inbox stays on your own website.
          <br />
          This app opens it on your phone.
        </p>
      </div>
    </div>
  );
}

function ByEmail({ onBack }: { onBack: () => void }) {
  const app = useApp();
  const [email, setEmail] = useState("");
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
        <h1>Sign in by email</h1>
        <p>We send a link to the address you sign in to your inbox with. Open it on this phone.</p>
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
