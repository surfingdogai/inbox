import { useEffect, useState } from "react";
import { useApp } from "../context";

/** Opening the app asks for the owner's fingerprint, face or screen lock first (BiometricPrompt). */
export function Lock({ onUnlock }: { onUnlock: () => void }) {
  const { native } = useApp();
  const [tried, setTried] = useState(false);
  const unlock = async () => {
    const ok = await native.authenticate("Open your inbox").catch(() => false);
    setTried(true);
    if (ok) onUnlock();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once, when the app opens
  useEffect(() => {
    void unlock();
  }, []);
  return (
    <div className="lock screen">
      <span className="badge lg" aria-hidden="true">
        SD
      </span>
      <h2>Your inbox is locked</h2>
      {tried && <p>Unlock with your fingerprint, face or screen lock.</p>}
      <button type="button" className="btn primary" style={{ minWidth: 200 }} onClick={() => void unlock()}>
        Unlock
      </button>
    </div>
  );
}
