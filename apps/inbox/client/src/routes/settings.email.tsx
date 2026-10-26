import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";
import { ErrorState } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { api, problemOf } from "../lib/api";
import {
  breakAtDots,
  checkedWords,
  forwardWords,
  linkHost,
  rowsText,
  senderWords,
  shortName,
  stepsFor,
  webPersonMailto,
} from "../lib/email";
import { qk, useEmailChannel, useSaveSettings, useSettings } from "../lib/queries";
import type { DnsRow, EmailChannelView, ForwardView, MailProvider } from "../lib/types";

export const Route = createFileRoute("/settings/email")({
  component: EmailPage,
});

/**
 * Settings → Email (ADR-026): the business's existing addresses forwarded to the inbox's own — each
 * with its provider's steps, the confirmation the provider sends (shown, never acted on) and a live
 * check — and who the business's email goes out from, with the records that let it go from the
 * business's own domain where the host offers it. On one's own server without an address yet, the
 * address its mail routing delivers here.
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
      {v.inbound ? <EmailCard view={v} inbound={v.inbound.address} /> : <OwnInboundCard />}
      <SendingCard view={v} />
    </>
  );
}

// ---- forwarding the business's existing addresses ------------------------------------------------

function EmailCard({ view, inbound }: { view: EmailChannelView; inbound: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card glass stack">
      <SectionHead title="Email" />
      <p className="lede small">Forward the address your customers already write to.</p>
      <div className="email-address">
        <span className="hint email-to">Forward it to</span>
        <span className="mono-soft email-addr">{inbound}</span>
        <CopyButton text={inbound} what="the address" />
      </div>
      {view.forwards.length > 0 && (
        <ul className="email-forwards">
          {view.forwards.map((f) => (
            <ForwardRow
              key={f.id}
              f={f}
              inbound={inbound}
              open={open === f.id}
              onToggle={() => setOpen((o) => (o === f.id ? null : f.id))}
            />
          ))}
        </ul>
      )}
      <AddForward view={view} onAdded={(id) => setOpen(id)} />
      <p className="hint">
        Customers' replies come back to the same conversation.
        {view.owner_replies && " You can also answer an alert by replying to it."}
      </p>
    </section>
  );
}

/** On one's own server: the address the server's mail routing delivers here. */
function OwnInboundCard() {
  const settings = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const id = useId();
  const problem = save.error ? problemOf(save.error) : null;
  return (
    <section className="card glass stack">
      <SectionHead title="Email" />
      <div>
        <label className="label" htmlFor={id}>
          Address
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
          {problem ? (
            (problem.field("email.inboundAddress") ?? problem.detail)
          ) : (
            <>
              The address your mail routing delivers here. It also needs the inbound email secret (General → Advanced).
              How:{" "}
              <a href="https://surfingdog.ai/docs/email#your-own-server" target="_blank" rel="noopener noreferrer">
                surfingdog.ai/docs/email
              </a>
            </>
          )}
        </div>
      </div>
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
  // Checking also clears a confirmation the owner dealt with: one step, not two.
  const check = useMutation({ mutationFn: () => api.checkForward(f.id), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.removeForward(f.id), onSuccess: done });
  const [asking, setAsking] = useState(false);
  const words = forwardWords(f);
  const steps = stepsFor(f.provider, inbound, f.address);
  const problem = check.error ?? remove.error;
  const provider = f.confirmation?.provider || f.provider_name;
  return (
    <li className="email-forward">
      <div className="email-forward-head">
        <span className="email-addr">{f.address}</span>
        <span className={clsx("email-state", `is-${words.tone}`)}>{words.text}</span>
      </div>
      {f.state === "working" && f.plus_ok && (
        <p className="hint">Customers' replies come back through this address too.</p>
      )}
      {f.confirmation && (
        <div className="email-confirm" role="status">
          <span className="label">{provider} asks you to confirm</span>
          {f.confirmation.url && (
            <a className="btn btn-secondary btn-sm" href={f.confirmation.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="icon" aria-hidden="true" />
              Open the confirmation
            </a>
          )}
          {f.confirmation.code && (
            <div className="email-address">
              <span className="email-code">{f.confirmation.code}</span>
              <CopyButton text={f.confirmation.code} what="the code" small />
            </div>
          )}
          <p className="hint">
            {f.confirmation.url
              ? `${f.confirmation.code ? `Open it, or copy the code into ${provider}'s forwarding settings. ` : ""}It opens ${linkHost(f.confirmation.url)}.`
              : `Copy the code into ${provider}'s forwarding settings.`}
          </p>
          <div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              Check forwarding
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="email-steps">
          <div className="email-steps-head">
            <span className="label">In {f.provider_name}</span>
            <span className="hint email-to">
              Forward to <span className="mono-soft">{inbound}</span>
            </span>
            <CopyButton text={inbound} what="the address" small />
          </div>
          <ol className="found-steps">
            {steps.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {steps.note && <p className="hint">{steps.note}</p>}
        </div>
      )}
      {asking ? (
        <div className="email-ask" role="alertdialog" aria-label={`Remove ${f.address}?`}>
          <p className="hint email-ask-text">
            Remove {f.address}? Its mail stops arriving here once you turn forwarding off.
          </p>
          <div className="email-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(false)}>
              Keep
            </button>
          </div>
        </div>
      ) : (
        <div className="email-actions">
          {!f.confirmation && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={check.isPending || f.checking}
              onClick={() => check.mutate()}
            >
              {f.checking ? "Checking…" : "Check forwarding"}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onToggle} aria-expanded={open}>
            {open ? "Hide steps" : "Steps"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={remove.isPending}
            onClick={() => (f.state === "working" ? setAsking(true) : remove.mutate())}
          >
            Remove
          </button>
        </div>
      )}
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
  const [choosing, setChoosing] = useState(false);
  const id = useId();
  const name = useId();
  const add = useMutation({
    mutationFn: () => api.addForward({ address: address.trim(), provider: provider ?? guessed ?? "other" }),
    onSuccess: (f) => {
      setAddress("");
      setProvider(null);
      setGuessed(null);
      setChoosing(false);
      onAdded(f.id);
      void qc.invalidateQueries({ queryKey: qk.email });
    },
  });
  // The provider is read from the address (its domain, its MX records) once it looks like one.
  useEffect(() => {
    const a = address.trim();
    setGuessed(null);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a)) return;
    let live = true;
    const t = setTimeout(() => {
      api
        .emailProvider(a)
        .then((r) => {
          if (live) setGuessed(r.provider);
        })
        .catch(() => {
          if (live) setGuessed("other");
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [address]);
  const chosen = provider ?? guessed;
  const detected = guessed !== null && guessed !== "other";
  const showChips = guessed !== null && (!detected || choosing);
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
        onChange={(e) => {
          setAddress(e.target.value);
          setProvider(null);
          setChoosing(false);
        }}
      />
      {detected && !choosing && (
        <p className="hint email-detected">
          On {view.providers.find((p) => p.id === chosen)?.name ?? ""} ·{" "}
          <button type="button" className="email-link" onClick={() => setChoosing(true)}>
            Not right?
          </button>
        </p>
      )}
      {showChips && (
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
  const working = view.forwards.filter((f) => f.state === "working" && f.check_seen_at !== null);
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
            ? view.replies === "none"
              ? view.reply_domain
                ? `In your name. Customers can't reply to these yet: set Customers reply to in Settings to an address at ${view.reply_domain}.`
                : "In your name. Customers can't reply to these yet: they reach you through your inbox's page."
              : view.reply_to
                ? `In your name. Customers' replies go to ${view.reply_to}.`
                : "In your name. Customers' replies come back here."
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
  const problemLine = problem && (
    <p className="hint error" role="alert">
      {problemOf(problem).detail}
    </p>
  );
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
        {problemLine}
      </div>
    );
  }
  // In use: the From line above says it all; only the way back.
  if (own.state === "verified" && view.sending.mode === "own") {
    return (
      <div className="email-own">
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={ask.isPending}
            onClick={() => ask.mutate(null)}
          >
            Stop sending from it
          </button>
        </div>
        {problemLine}
      </div>
    );
  }
  const domain = own.address.split("@")[1] ?? "";
  const rows = own.records;
  return (
    <div className="email-own">
      <span className="label">
        {own.state === "failed" ? own.address : `Switching to ${own.address} once these records are in.`}
      </span>
      <p className={clsx("hint", own.state === "failed" && "error")}>{senderWords(own)}</p>
      {rows.length > 0 && (
        <>
          <table className="email-dns" aria-label={`DNS records for ${domain}`}>
            <thead>
              <tr className="email-dns-head">
                <th scope="col">Type</th>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
                <th scope="col">
                  <span className="sr-only">Found</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={`${r.type}${r.name}${r.value}`} r={r} domain={domain} />
              ))}
            </tbody>
          </table>
          <p className="hint">None of these change where your email goes.</p>
        </>
      )}
      {own.dnsProvider && own.dnsProvider.steps.length > 0 && (
        <div className="email-steps">
          <span className="label">In {own.dnsProvider.name}</span>
          <ol className="found-steps">
            {own.dnsProvider.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="email-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? "Checking…" : "Check DNS"}
        </button>
        {rows.length > 0 && <CopyButton text={rowsText(rows, domain)} what="all the records" label="Copy all" />}
        {rows.length > 0 && (
          <a className="btn btn-ghost btn-sm" href={webPersonMailto(domain, rows)}>
            Send to my web person
          </a>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={ask.isPending}
          onClick={() => ask.mutate(null)}
        >
          Cancel
        </button>
      </div>
      {own.checkedAt && <p className="hint">{checkedWords(own.checkedAt)}</p>}
      {problemLine}
    </div>
  );
}

function Row({ r, domain }: { r: DnsRow; domain: string }) {
  const nameShort = shortName(r.name, domain);
  return (
    <tr className={clsx("email-dns-row", r.ok === true && "is-ok")}>
      <td className="email-dns-type">
        {r.type}
        {r.priority !== undefined && <span className="hint"> {r.priority}</span>}
      </td>
      <td className="email-dns-val">
        <Dotted value={nameShort} />
        <CopyButton text={nameShort} what="the name" small />
      </td>
      <td className="email-dns-val">
        <Dotted value={r.value} />
        <CopyButton text={r.value} what="the value" small />
        {r.purpose && <span className="hint email-purpose">{r.purpose}</span>}
      </td>
      <td className="email-mark">
        <span aria-hidden="true">{r.ok ? "✓" : "○"}</span>
        <span className="sr-only">{r.ok ? "found" : "not found yet"}</span>
      </td>
    </tr>
  );
}

/** A DNS value that breaks only after a dot, never mid-word. */
function Dotted({ value }: { value: string }) {
  let at = 0;
  const parts = breakAtDots(value).map((part) => {
    const from = at;
    at += part.length;
    return { part, from };
  });
  return (
    <span className="mono-soft email-dotted">
      {parts.map(({ part, from }) => (
        <Fragment key={`at${from}`}>
          {part}
          <wbr />
        </Fragment>
      ))}
    </span>
  );
}

function CopyButton({ text, what, small, label }: { text: string; what: string; small?: boolean; label?: string }) {
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
      {!small && (copied ? "Copied" : (label ?? "Copy"))}
    </button>
  );
}
