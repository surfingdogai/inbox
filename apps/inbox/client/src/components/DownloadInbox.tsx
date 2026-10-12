import { Download } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, problemOf } from "../lib/api";
import { saveFile } from "../lib/download";
import { Toast } from "./Feedback";
import { Field } from "./Form";

/**
 * Downloading the inbox: one file with every request and conversation, the customers, the services,
 * the hours, the rules and the settings, to run on a server of the owner's own. The inbox emails the
 * owner a code first, and tells them once it is done.
 */
export function DownloadInbox() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const ask = async () => {
    setProblem(null);
    setSaved(null);
    setBusy(true);
    try {
      setSentTo((await api.downloadCode()).sent_to);
      setCode("");
    } catch (error) {
      setProblem(problemOf(error).detail);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const { blob, filename } = await api.downloadInbox(code.trim());
      saveFile(blob, filename);
      setSaved(`Saved ${filename}. An email tells you it was downloaded.`);
      setSentTo(null);
      setCode("");
    } catch (error) {
      setProblem(problemOf(error).detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card glass stack">
      <h3 className="sec">Download your inbox</h3>
      <p className="hint">
        One file with every request and conversation, the customers, the services, the hours, the rules and the
        settings, which you can run on a server of your own. It leaves out who is signed in, keys, connected AI apps and
        every secret.
      </p>
      {problem && <Toast tone="danger" text="Not downloaded." sub={problem} onDismiss={() => setProblem(null)} />}
      {saved && <Toast tone="success" text={saved} onDismiss={() => setSaved(null)} />}
      {sentTo === null ? (
        <div className="rowx">
          <button type="button" className="btn btn-secondary" onClick={() => void ask()} disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Email me a code
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => void submit(e)}>
          <Field id="dl-code" label="Code" hint={`Sent to ${sentTo}. It works for 10 minutes.`}>
            <input
              id="dl-code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <div className="rowx">
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
              Download
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void ask()} disabled={busy}>
              Send another code
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
