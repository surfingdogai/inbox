import { useEffect, useState } from "react";
import { useApp } from "../context";
import { Mark } from "./icons";

/**
 * Opening the app asks for the owner's fingerprint, face or screen lock first (BiometricPrompt). On a
 * phone with no screen lock at all, nothing opens: the owner is asked to set one, since the app's keys
 * rely on it.
 */
export function Lock({ insecure, onUnlock }: { insecure: boolean; onUnlock: () => Promise<boolean> }) {
  const { native } = useApp();
  const [tried, setTried] = useState(false);
  const unlock = async () => {
    if (insecure) {
      setTried(true);
      await onUnlock();
      return;
    }
    const ok = await native.authenticate("Open your inbox").catch(() => false);
    setTried(true);
    if (ok) await onUnlock();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once, when the app opens
  useEffect(() => {
    if (!insecure) void unlock();
  }, []);
  if (insecure)
    return (
      <div className="lock screen">
        <Mark />
        <h2>Set a screen lock first</h2>
        <p>
          Your inbox opens only on a phone with a PIN, pattern or password. Set one in the phone's settings, then come
          back.
        </p>
        {tried && <p>This phone still has no screen lock.</p>}
        <button type="button" className="btn primary" style={{ minWidth: 200 }} onClick={() => void unlock()}>
          I've set one
        </button>
      </div>
    );
  return (
    <div className="lock screen">
      <Mark />
      <h2>Your inbox is locked</h2>
      {tried && <p>Unlock with your fingerprint, face or screen lock.</p>}
      <button type="button" className="btn primary" style={{ minWidth: 200 }} onClick={() => void unlock()}>
        Unlock
      </button>
    </div>
  );
}
