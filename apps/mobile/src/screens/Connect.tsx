import { type FormEvent, useEffect, useRef, useState } from "react";
import { inboxOrigin, type PhoneLink } from "../../../../packages/core/src/phones/links";
import { useApp } from "../context";
import { type Scanner, startScanner } from "../lib/scan";
import { findInbox } from "../lib/session";
import { ChevronLeft, Corners } from "./icons";

/**
 * Connect your inbox (the approved Connect screen): scan the code in Settings → Phone, nothing to
 * type. Without a camera, a sign-in link by email: the owner types the address they sign in with, and
 * the app finds the inbox from its domain, asking for the inbox's address only when it cannot.
 */
export function Connect({ canGoBack, allowLocal }: { canGoBack: boolean; allowLocal: boolean }) {
  const app = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<Scanner | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [byEmail, setByEmail] = useState(false);

  useEffect(() => () => scanner.current?.stop(), []);

  const pair = async (link: PhoneLink) => {
    setScanning(false);
    setBusy(true);
    setError(null);
    try {
      const entry = link.kind === "pair" ? await app.sessions.pair(link) : await app.sessions.redeem(link);
      await app.connected(entry);
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
      scanner.current = await startScanner(video.current, (link) => void pair(link), allowLocal);
    } catch {
      setScanning(false);
      setError("The camera did not start. Allow the camera for this app, or use a sign-in link instead.");
    }
  };

  if (byEmail) return <ByEmail onBack={() => setByEmail(false)} />;

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
          <button type="button" className="btn primary" disabled={busy} onClick={() => void scan()}>
            Scan the code
          </button>
        )}
        <button type="button" className="btn quiet" onClick={() => setByEmail(true)}>
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
