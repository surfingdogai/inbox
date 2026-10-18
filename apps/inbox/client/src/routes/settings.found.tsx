import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import { ErrorState } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { api, problemOf } from "../lib/api";
import {
  DNS_RECORD,
  DNS_RECORD_LINE,
  FIX_SHOWN,
  GROUP_OF,
  GROUPS,
  headLines,
  ITEM_WORDS,
  PLATFORMS,
  type Platform,
  ROBOTS_LEAD,
  ROBOTS_NOTE,
  shortDetail,
  verdict,
  webPersonEmail,
  webPersonMailto,
} from "../lib/found";
import type { DiscoveryItem, DiscoveryResult, DiscoverySnippets, DiscoveryView } from "../lib/types";

export const Route = createFileRoute("/settings/found")({
  component: FoundPage,
});

/**
 * Settings → Be found (ADR-022), in the order a small owner needs it: where the website is, that platform's
 * steps with only the lines it needs, one DNS record folded for whoever manages DNS, Check and an email for
 * whoever runs the site, then what the check found. Surfing Dog's checker reads the site's public pages only
 * when the owner presses Check; the platform it read is then picked, unless the owner picked one.
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
  const [chosen, setChosen] = useState<Platform["id"] | null>(null);
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
  const picked = chosen ?? check.data?.platform ?? null;
  const platform = PLATFORMS.find((p) => p.id === picked);
  const problem = check.error ? problemOf(check.error) : null;
  return (
    <>
      <p className="hint">
        On <b>{view.domain}</b>, leading to <b>{view.host}</b>.
        {view.domainFrom === "inbox" && " Not your website? Name it in General."}
      </p>
      <fieldset className="chips-field">
        <legend className="label">Where is your website?</legend>
        <div className="chips" role="radiogroup">
          {PLATFORMS.map((p) => (
            <label key={p.id} className="chip">
              <input type="radio" name={name} checked={picked === p.id} onChange={() => setChosen(p.id)} />
              <span>{p.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {platform && <PlatformSteps p={platform} s={s} />}
      <details className="found-dns">
        <summary className="label">{DNS_RECORD}</summary>
        <div className="found-line">
          <span className="label">{DNS_RECORD_LINE}</span>
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
      </details>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? "Checking…" : "Check"}
        </button>
        <a className="btn btn-ghost btn-sm" href={webPersonMailto(view.domain, view.host, s)}>
          Send to my web person
        </a>
        <CopyButton text={webPersonEmail(view.domain, view.host, s)} what="the email" label="Copy the email" />
      </div>
      <p className="hint">
        Check asks Surfing Dog's checker to read your website's public pages, as a browser would. Nothing is sent until
        you press it.
      </p>
      {problem && (
        <p className="hint error" role="alert">
          {problem.detail}
        </p>
      )}
      {check.data && <CheckCard result={check.data} />}
    </>
  );
}

function PlatformSteps({ p, s }: { p: Platform; s: DiscoverySnippets }) {
  return (
    <div className="found-platform">
      {p.soon && (
        <p className="hint">
          <span className="found-soon">Soon</span> {p.soon}
        </p>
      )}
      <ol className="found-steps">
        {p.steps.map((st) => (
          <li key={st}>{st}</li>
        ))}
      </ol>
      {p.blocks.includes("head") && <CopyLine label="Inside <head> on every page" text={headLines(s)} rows={4} />}
      {p.blocks.includes("llms_line") && <CopyLine label="In llms.txt" text={s.llms_line} rows={2} />}
      {p.blocks.includes("llms_file") && (
        <CopyLine label="No llms.txt yet? The whole file" text={s.llms_file} rows={5} />
      )}
      {p.blocks.includes("inbox_file") && (
        <p className="hint">
          The inbox file, at <span className="mono-soft found-wrap">{s.well_known}</span>: a copy of{" "}
          <span className="mono-soft found-wrap">{s.manifest}</span>, or a redirect to it.
        </p>
      )}
      {p.note && <p className="hint">{p.note}</p>}
    </div>
  );
}

function CheckCard({ result }: { result: DiscoveryResult }) {
  return (
    <div className="found-check" role="status">
      <p className={clsx("found-verdict", result.ready && "found-ready")}>{verdict(result)}</p>
      {(["inbox", "site"] as const).map((g) => {
        const rows = result.items.filter((it) => GROUP_OF[it.id] === g);
        if (rows.length === 0) return null;
        return (
          <div key={g} className="found-group">
            <span className="label">
              {GROUPS[g].replace("{domain}", result.domain).replace("{ways}", String(result.ways))}
            </span>
            <ul className="found-rows">
              {rows.map((it) => (
                <Row key={it.id} it={it} domain={result.domain} />
              ))}
            </ul>
          </div>
        );
      })}
      {result.next && <p className="hint">Next: {result.next.split("\n")[0]}</p>}
    </div>
  );
}

function Row({ it, domain }: { it: DiscoveryItem; domain: string }) {
  const mark = it.state === "ok" ? "ok" : it.state === "missing" ? "missing" : "bad";
  const fix = mark !== "ok" && FIX_SHOWN.has(it.id) ? it.fix : undefined;
  return (
    <li className={`is-${mark}`}>
      <span className="found-mark" aria-hidden="true">
        {mark === "ok" ? "✓" : mark === "missing" ? "○" : "!"}
      </span>
      <span>
        <b className="found-item">{ITEM_WORDS[it.id]}</b> {shortDetail(it.detail, it.state, domain)}
      </span>
      {fix && it.id === "robots" && it.fix_lines && (
        <div className="found-fix">
          <span>{ROBOTS_LEAD}</span>
          <pre className="found-code">{it.fix_lines}</pre>
          <CopyButton text={it.fix_lines} what="the robots.txt lines" />
          <span className="hint">{ROBOTS_NOTE}</span>
        </div>
      )}
      {fix && it.id === "robots" && !it.fix_lines && (
        <div className="found-fix">
          <span>{fix.split("\n\n")[0]}</span>
          <span className="hint">{ROBOTS_NOTE}</span>
        </div>
      )}
      {fix && it.id !== "robots" && <span className="found-fix">{fix}</span>}
    </li>
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

function CopyButton({ text, what, label = "Copy" }: { text: string; what: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-label={label === "Copy" ? `Copy ${what}` : label}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
      {copied ? "Copied" : label}
    </button>
  );
}
