import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ErrorState } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { api, problemOf } from "../lib/api";
import { forwardWords, linkHost, senderWords, shortName, stepsFor } from "../lib/email";
import { qk, useEmailChannel, useSaveSettings, useSettings } from "../lib/queries";
import type { DnsRow, EmailChannelView, ForwardView, MailProvider } from "../lib/types";

export const Route = createFileRoute("/settings/email")({
  component: EmailPage,
});

/**
 * Settings → Email (ADR-026): the inbox's own address, the business's existing addresses forwarded to
 * it — each with its provider's steps, the confirmation the provider sends (shown, never acted on) and
 * a live check — and who the business's email goes out from, with the records that let it go from
 * the business's own domain where the host offers it.
 */
function EmailPage() {
  const view = useEmailChannel();
  if (view.isPending) {
    return (
      <div className="card glass" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
      </div>
    );
  }
  if (view.isError) {
    return (
      <div className="card glass">
        <ErrorState
          title="Could not load this"
          text={problemOf(view.error).detail}
          onRetry={() => void view.refetch()}
        />
      </div>
    );
  }
  const v = view.data;
  return (
    <>
      <InboundCard view={v} />
      {v.inbound && <ForwardsCard view={v} inbound={v.inbound.address} />}
      <SendingCard view={v} />
    </>
  );
}

// ---- the inbox's own address ----------------------------------------------------------------------

function InboundCard({ view }: { view: EmailChannelView }) {
  return (
    <section className="card glass stack">
      <SectionHead title="Email" />
      {view.inbound ? (
        <>
          <p className="lede small">Customers' emails, and your forwarded address, arrive here.</p>
          <div className="email-address">
            <span className="mono-soft email-addr">{view.inbound.address}</span>
            <CopyButton text={view.inbound.address} what="the address" />
          </div>
          <p className="hint">
            Each conversation gets an address of its own, so replies land in the right place.
            {view.owner_replies && " Reply to an alert to answer the customer."}
          </p>
        </>
      ) : (
        <OwnInbound />
      )}
    </section>
  );
}

/** On one's own server: the address the server's mail routing delivers here. */
function OwnInbound() {
  const settings = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const id = useId();
  const problem = save.error ? problemOf(save.error) : null;
  return (
    <>
      <p className="lede small">This inbox has no email address yet.</p>
      <div>
        <label className="label" htmlFor={id}>
          Its address
        </label>
        <div className="email-row">
          <input
            id={id}
            className="input email-grow"
            type="email"
            placeholder="inbox@your-shop.com"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!address.trim() || save.isPending || !settings.data}
            onClick={() =>
              save.mutate(
                { doc: { email: { inboundAddress: address.trim() } }, expected_version: settings.data?.version },
                { onSuccess: () => void qc.invalidateQueries({ queryKey: qk.email }) },
              )
            }
          >
            Save
          </button>
        </div>
        <div className={clsx("hint", problem && "error")} role={problem ? "alert" : undefined}>
          {problem
            ? (problem.field("email.inboundAddress") ?? problem.detail)
            : "The address your mail routing delivers here."}
        </div>
      </div>
    </>
  );
}

// ---- forwarding the business's existing addresses ------------------------------------------------

function ForwardsCard({ view, inbound }: { view: EmailChannelView; inbound: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card glass stack">
      <SectionHead title="Forward your existing address" />
      <p className="lede small">Keep the address customers know. Forward it here.</p>
      {view.forwards.length > 0 && (
        <ul className="email-forwards">
          {view.forwards.map((f) => (
            <ForwardRow
              key={f.id}
              f={f}
              inbound={inbound}
              open={open === f.id || f.state === "confirm"}
              onToggle={() => setOpen((o) => (o === f.id ? null : f.id))}
            />
          ))}
        </ul>
      )}
      <AddForward view={view} onAdded={(id) => setOpen(id)} />
    </section>
  );
}

function ForwardRow({
  f,
  inbound,
  open,
  onToggle,
}: {
  f: ForwardView;
  inbound: string;
  open: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: qk.email });
  const check = useMutation({ mutationFn: () => api.checkForward(f.id), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.removeForward(f.id), onSuccess: done });
  const confirmed = useMutation({ mutationFn: () => api.confirmedForward(f.id), onSuccess: done });
  const words = forwardWords(f);
  const steps = stepsFor(f.provider, inbound);
  const problem = check.error ?? remove.error ?? confirmed.error;
  return (
    <li className="email-forward">
      <div className="email-forward-head">
        <span className="email-addr">{f.address}</span>
        <span className={clsx("email-state", `is-${words.tone}`)}>{words.text}</span>
      </div>
      {f.state === "working" && f.plus_ok && (
        <p className="hint">Replies to your customers come back through this address too.</p>
      )}
      {f.confirmation && (
        <div className="email-confirm" role="status">
          <span className="label">{f.provider_name} asks you to confirm</span>
          {f.confirmation.code && (
            <div className="email-address">
              <span className="email-code">{f.confirmation.code}</span>
              <CopyButton text={f.confirmation.code} what="the code" />
            </div>
          )}
          {f.confirmation.url && (
            <a className="btn btn-ghost btn-sm" href={f.confirmation.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="icon" aria-hidden="true" />
              Open the confirmation
            </a>
          )}
          <p className="hint">
            {f.confirmation.code
              ? "Type the code in your mail settings, or open the link."
              : "Open the link to confirm."}
            {f.confirmation.url && ` It opens ${linkHost(f.confirmation.url)}.`} Then press Check forwarding.
          </p>
          <div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={confirmed.isPending}
              onClick={() => confirmed.mutate()}
            >
              Done
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="email-steps">
          <span className="label">In {f.provider_name}</span>
          <ol className="found-steps">
            {steps.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {steps.note && <p className="hint">{steps.note}</p>}
        </div>
      )}
      <div className="email-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={check.isPending || f.checking}
          onClick={() => check.mutate()}
        >
          {f.checking ? "Checking…" : "Check forwarding"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onToggle} aria-expanded={open}>
          {open ? "Hide steps" : "Steps"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove
        </button>
      </div>
      {f.state === "not_yet" && !f.checking && (
        <p className="hint">The check has not come back. Look at the steps again, then check once more.</p>
      )}
      {problem && (
        <p className="hint error" role="alert">
          {problemOf(problem).detail}
        </p>
      )}
    </li>
  );
}

function AddForward({ view, onAdded }: { view: EmailChannelView; onAdded: (id: string) => void }) {
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const [provider, setProvider] = useState<MailProvider | null>(null);
  const [guessed, setGuessed] = useState<MailProvider | null>(null);
  const id = useId();
  const name = useId();
  const add = useMutation({
    mutationFn: () => api.addForward({ address: address.trim(), provider: provider ?? guessed ?? "other" }),
    onSuccess: (f) => {
      setAddress("");
      setProvider(null);
      setGuessed(null);
      onAdded(f.id);
      void qc.invalidateQueries({ queryKey: qk.email });
    },
  });
  // The provider is read from the address (its domain, its MX records) once it looks like one.
  useEffect(() => {
    const a = address.trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a)) return;
    let live = true;
    const t = setTimeout(() => {
      api
        .emailProvider(a)
        .then((r) => {
          if (live) setGuessed(r.provider);
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [address]);
  const chosen = provider ?? guessed;
  const problem = add.error ? problemOf(add.error) : null;
  return (
    <div className="email-add">
      <label className="label" htmlFor={id}>
        {view.forwards.length ? "Another address" : "Your address"}
      </label>
      <input
        id={id}
        className="input"
        type="email"
        placeholder="support@your-shop.com"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      {address.trim() && (
        <fieldset className="chips-field">
          <legend className="label">Where it lives</legend>
          <div className="chips" role="radiogroup">
            {view.providers.map((p) => (
              <label key={p.id} className="chip">
                <input type="radio" name={name} checked={chosen === p.id} onChange={() => setProvider(p.id)} />
                <span>{p.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!address.trim() || !chosen || add.isPending}
          onClick={() => add.mutate()}
        >
          Add
        </button>
      </div>
      {problem && (
        <p className="hint error" role="alert">
          {problem.field("address") ?? problem.detail}
        </p>
      )}
    </div>
  );
}

// ---- who the business's email is from -------------------------------------------------------------

function SendingCard({ view }: { view: EmailChannelView }) {
  const s = view.sending;
  const own = s.own;
  const working = view.forwards.filter((f) => f.state === "working");
  return (
    <section className="card glass stack">
      <SectionHead title="Replies go out from" />
      {s.from ? (
        <p className="email-from">
          <span>{s.name}</span> <span className="mono-soft">&lt;{s.from}&gt;</span>
        </p>
      ) : (
        <p className="hint">Nothing to send from yet.</p>
      )}
      <p className="hint">
        {s.mode === "own"
          ? "Your own address, signed for your domain."
          : s.mode === "host"
            ? "In your name. Customers' replies come back here."
            : s.mode === "settings"
              ? "As your server's mail service sends it."
              : ""}
      </p>
      {own && own.state !== "unavailable" && <OwnSender view={view} working={working} />}
    </section>
  );
}

function OwnSender({ view, working }: { view: EmailChannelView; working: readonly ForwardView[] }) {
  const own = view.sending.own;
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: qk.email });
  const ask = useMutation({ mutationFn: (address: string | null) => api.setSender(address), onSuccess: done });
  const check = useMutation({ mutationFn: api.checkSender, onSuccess: done });
  const name = useId();
  const [pick, setPick] = useState<string | null>(null);
  if (!own) return null;
  const problem = ask.error ?? check.error;
  if (own.state === "none" || !own.address) {
    return (
      <div className="email-own">
        <span className="label">Send from your own address</span>
        {working.length === 0 ? (
          <p className="hint">Forward an address here first: once it works, email can go from it.</p>
        ) : (
          <>
            <div className="chips" role="radiogroup">
              {working.map((f) => (
                <label key={f.id} className="chip">
                  <input
                    type="radio"
                    name={name}
                    checked={(pick ?? working[0]?.address) === f.address}
                    onChange={() => setPick(f.address)}
                  />
                  <span>{f.address}</span>
                </label>
              ))}
            </div>
            <div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={ask.isPending}
                onClick={() => ask.mutate(pick ?? working[0]?.address ?? null)}
              >
                Use it
              </button>
            </div>
          </>
        )}
        {problem && (
          <p className="hint error" role="alert">
            {problemOf(problem).detail}
          </p>
        )}
      </div>
    );
  }
  const domain = own.address.split("@")[1] ?? "";
  return (
    <div className="email-own">
      <span className="label">{own.address}</span>
      <p className={clsx("hint", own.state === "failed" && "error")}>{senderWords(own)}</p>
      {own.records.length > 0 && own.state !== "verified" && (
        <ul className="email-records">
          {own.records.map((r) => (
            <Record key={`${r.type}${r.name}${r.value}`} r={r} domain={domain} />
          ))}
        </ul>
      )}
      <div className="email-actions">
        {own.state !== "verified" && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? "Checking…" : "Check DNS"}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={ask.isPending}
          onClick={() => ask.mutate(null)}
        >
          Stop
        </button>
      </div>
      {own.checkedAt && <p className="hint">Last looked at {new Date(own.checkedAt).toLocaleString()}.</p>}
      {problem && (
        <p className="hint error" role="alert">
          {problemOf(problem).detail}
        </p>
      )}
    </div>
  );
}

function Record({ r, domain }: { r: DnsRow; domain: string }) {
  return (
    <li className={clsx("email-record", r.ok === true && "is-ok")}>
      <span className="email-mark" aria-hidden="true">
        {r.ok ? "✓" : "○"}
      </span>
      <dl className="found-rec mono-soft">
        <dt>Type</dt>
        <dd>{r.type}</dd>
        <dt>Name</dt>
        <dd>
          {shortName(r.name, domain)}
          <CopyButton text={shortName(r.name, domain)} what="the name" small />
        </dd>
        {r.priority !== undefined && (
          <>
            <dt>Priority</dt>
            <dd>{r.priority}</dd>
          </>
        )}
        <dt>Value</dt>
        <dd>
          {r.value}
          <CopyButton text={r.value} what="the value" small />
        </dd>
      </dl>
      {r.purpose && <span className="hint email-purpose">{r.purpose}</span>}
    </li>
  );
}

function CopyButton({ text, what, small }: { text: string; what: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={clsx("btn btn-ghost btn-sm", small && "email-copy")}
      aria-label={`Copy ${what}`}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
      {!small && (copied ? "Copied" : "Copy")}
    </button>
  );
}
