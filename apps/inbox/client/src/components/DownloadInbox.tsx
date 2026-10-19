import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, problemOf } from "../lib/api";
import { saveFile } from "../lib/download";
import { Toast } from "./Feedback";
import { Field, Switch } from "./Form";

/**
 * Downloading the inbox: one file with every request and conversation, the customers, the services,
 * the hours, the rules and the settings, to run on a server of the owner's own. The inbox emails the
 * owner a code first, and tells them once it is done. The key receipts are signed with goes too only
 * when the owner switches it on (on from the start while the inbox is closing): a routine backup
 * never carries a password-like key. Where the inbox cannot copy its own database (Cloudflare D1)
 * the card says how to copy it instead, and offers no button that could only fail.
 */
export function DownloadInbox() {
  const here = useQuery({
    queryKey: ["download"],
    queryFn: api.downloadAvailable,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const away = here.error ? problemOf(here.error) : null;
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [withKey, setWithKey] = useState(false);
  // Leaving (a hosted inbox closing): the copy is how the business keeps its inbox, key included.
  const leaving = here.data?.leaving === true;
  useEffect(() => {
    if (leaving) setWithKey(true);
  }, [leaving]);

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
      const { blob, filename } = await api.downloadInbox(code.trim(), withKey);
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

  if (away?.code === "not_available") {
    return (
      <section className="card glass stack">
        <h3 className="sec">Download your inbox</h3>
        <p className="hint">
          {/* The answer names the command in backticks: shown as code. */}
          {away.detail.split("`").map((part, i) => (i % 2 ? <code key={part}>{part}</code> : part))}
        </p>
      </section>
    );
  }

  return (
    <section className="card glass stack">
      <h3 className="sec">Download your inbox</h3>
      <p className="hint">
        Everything in your inbox in one file, ready to run on a server of your own. Sign-ins, API keys and connected AI
        apps stay behind.
      </p>
      <div>
        <Switch checked={withKey} onChange={setWithKey} disabled={busy}>
          Take the key your receipts are signed with
        </Switch>
        <p className="hint">Only when you are moving to a server of your own. Keep the file as safe as a password.</p>
      </div>
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
