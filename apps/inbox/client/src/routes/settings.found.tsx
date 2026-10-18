import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import { ErrorState } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { api, problemOf } from "../lib/api";
import { FIX_SHOWN, headLines, ITEM_WORDS, PLATFORMS, type Platform, webPersonMailto } from "../lib/found";
import type { DiscoveryResult, DiscoveryView } from "../lib/types";

export const Route = createFileRoute("/settings/found")({
  component: FoundPage,
});

/**
 * Settings → Be found (ADR-022): the few lines that lead AI agents from the business's own website to
 * this inbox, the steps where the site is, an email for whoever runs it, and a check by Surfing Dog's
 * checker, which reads the site's public pages only when the owner presses Check.
 */
function FoundPage() {
  const view = useQuery({ queryKey: ["discovery"], queryFn: api.discovery, staleTime: 60_000 });
  const check = useMutation({ mutationFn: api.checkDiscovery });
  return (
    <section className="card glass stack">
      <SectionHead title="Be found" />
      <p className="lede small">A few lines on your website lead AI agents to this inbox.</p>
      {view.isPending && <div className="skeleton sk-line" />}
      {view.isError && (
        <ErrorState
          title="Could not load this"
          text={problemOf(view.error).detail}
          onRetry={() => void view.refetch()}
        />
      )}
      {view.isSuccess && <Found view={view.data} check={check} />}
    </section>
  );
}

function Found({
  view,
  check,
}: {
  view: DiscoveryView;
  check: ReturnType<typeof useMutation<DiscoveryResult, Error, void>>;
}) {
  const [platform, setPlatform] = useState<Platform["id"]>("wordpress");
  const name = useId();
  if (!view.host) {
    return <p className="hint">This inbox has no public address yet. Once it has one, the lines are here.</p>;
  }
  if (!view.domain || !view.snippets) {
    return (
      <p className="hint">
        Name your website in <Link to="/settings">General</Link> first: the lines go there.
      </p>
    );
  }
  const s = view.snippets;
  const steps = PLATFORMS.find((p) => p.id === platform) ?? PLATFORMS[0];
  const problem = check.error ? problemOf(check.error) : null;
  return (
    <>
      <p className="hint">
        On <b>{view.domain}</b>, leading to <b>{view.host}</b>.
        {view.domainFrom === "inbox" && " Not your website? Name it in General."}
      </p>
      {check.data && <CheckCard result={check.data} />}
      {problem && (
        <p className="hint error" role="alert">
          {problem.detail}
        </p>
      )}
      <CopyLine label="Inside <head> on every page" text={headLines(s)} rows={4} />
      <CopyLine label="In llms.txt" text={s.llms_line} rows={2} />
      <div className="found-line">
        <span className="label">A DNS record, beside the one for this inbox</span>
        <dl className="found-rec mono-soft">
          <dt>Type</dt>
          <dd>TXT</dd>
          <dt>Name</dt>
          <dd>{s.dns_name}</dd>
          <dt>Value</dt>
          <dd>{s.dns_value}</dd>
        </dl>
        <CopyButton text={s.dns_value} what="the value" />
      </div>
      <p className="hint">
        And at <span className="mono-soft found-wrap">{s.well_known}</span>: a copy of this inbox's manifest, or a
        redirect to it.
      </p>
      <fieldset className="chips-field">
        <legend className="label">Where is your website?</legend>
        <div className="chips" role="radiogroup">
          {PLATFORMS.map((p) => (
            <label key={p.id} className="chip">
              <input type="radio" name={name} checked={platform === p.id} onChange={() => setPlatform(p.id)} />
              <span>{p.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {steps && (
        <ol className="found-steps">
          {steps.steps.map((st) => (
            <li key={st}>{st}</li>
          ))}
          {steps.note && <li className="hint">{steps.note}</li>}
        </ol>
      )}
      <div className="form-actions">
        <a className="btn btn-ghost btn-sm" href={webPersonMailto(view.domain, view.host, s)}>
          Send to my web person
        </a>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? "Checking…" : "Check"}
        </button>
      </div>
      <p className="hint">
        Check asks Surfing Dog's checker to read your website's public pages, as a browser would. Nothing is sent until
        you press it.
      </p>
    </>
  );
}

function CheckCard({ result }: { result: DiscoveryResult }) {
  return (
    <div className="found-check" role="status">
      <p className={clsx("found-verdict", result.ready && "found-ready")}>
        {result.ready
          ? `Agents can find it: ${result.ways} of 5 ways in place.`
          : `Not yet: ${result.ways} of 5 ways in place.`}
      </p>
      <ul className="found-rows">
        {result.items.map((it) => (
          <li key={it.id} className={it.state === "ok" ? "is-ok" : "is-no"}>
            <span aria-hidden="true">{it.state === "ok" ? "✓" : "·"}</span>
            <span>
              <b className="found-item">{ITEM_WORDS[it.id]}</b> {it.detail}
            </span>
            {it.state !== "ok" && it.fix && FIX_SHOWN.has(it.id) && (
              <textarea
                className="input found-code"
                readOnly
                rows={6}
                value={it.fix}
                aria-label={`The fix: ${ITEM_WORDS[it.id]}`}
              />
            )}
          </li>
        ))}
      </ul>
      {result.next && <p className="hint">Next: {result.next.split("\n")[0]}</p>}
    </div>
  );
}

function CopyLine({ label, text, rows }: { label: string; text: string; rows: number }) {
  const id = useId();
  return (
    <div className="found-line">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <textarea id={id} className="input found-code" readOnly rows={rows} value={text} />
      <CopyButton text={text} what={label.toLowerCase()} />
    </div>
  );
}

function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-label={`Copy ${what}`}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
