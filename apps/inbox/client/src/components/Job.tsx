import clsx from "clsx";
import { ExternalLink, FileText, Plus, Send, X } from "lucide-react";
import { useState } from "react";
import { moneyMajor, parseMoney } from "../lib/actions";
import { problemOf } from "../lib/api";
import { formatAddress, formatDay, formatMoney, formatWhen } from "../lib/format";
import { useTransition } from "../lib/queries";
import {
  areaLine,
  type FileView,
  stageWhen,
  toolName,
  URGENCY_WORDS,
  useItemFiles,
  useJobTool,
  useSendToJobTool,
  VISIT_WORDS,
} from "../lib/trades";
import type { ItemOf } from "../lib/types";
import { MoneyInput } from "./Choosers";
import "../trades.css";

/**
 * A request for a price's job (ADR-034 §4), on its detail screen: how urgent, whether a visit comes
 * first, where the site stands against the area (a band, never a distance), the windows that suit,
 * the photos and plans (through links that work for ten minutes), the owner's job tool, and a quote in
 * stages. Thin, small, quiet: one accent, the urgency, only when it is an emergency.
 */
export function JobBlock({
  item,
  tz,
  currency,
}: {
  item: ItemOf<"quote_request">;
  tz: string | undefined;
  currency: string;
}) {
  const p = item.payload;
  const job = p.job;
  const files = useItemFiles(item.id, (p.attachments?.length ?? 0) > 0);
  const tool = useJobTool(item.id, true);
  const area = areaLine(job?.areaCheck);
  const open = item.closedAt === null;
  if (!job && !(p.attachments?.length ?? 0) && !(tool.data?.tools.length ?? 0)) return null;
  return (
    <section className="job stack" aria-label="The job">
      {job && (
        <div className="job-pills">
          <span className={clsx("pill", job.urgency === "emergency" && "tint-warning")}>
            {URGENCY_WORDS[job.urgency]}
          </span>
          <span className="pill">{VISIT_WORDS[job.visit]}</span>
          {area && <span className="pill job-area">{area}</span>}
        </div>
      )}
      {job && (
        <dl className="fields">
          {job.site?.address && (
            <div className="wide">
              <dt>Site</dt>
              <dd>{formatAddress(job.site.address)}</dd>
            </div>
          )}
          {job.site?.accessNotes && (
            <div className="wide">
              <dt>Finding the way</dt>
              <dd className="prose">{job.site.accessNotes}</dd>
            </div>
          )}
          {job.windows?.length ? (
            <div className="wide">
              <dt>Times that suit</dt>
              <dd>
                <ul className="job-windows">
                  {job.windows.map((w) => (
                    <li key={`${w.from}${w.to}`}>{formatWhen(w.from, w.to, tz)}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {p.budget && (
            <div>
              <dt>Budget</dt>
              <dd>
                {formatMoney(p.budget)}
                {job.budgetMax ? ` – ${formatMoney(job.budgetMax)}` : ""}
              </dd>
            </div>
          )}
        </dl>
      )}
      {(p.attachments?.length ?? 0) > 0 && (
        <FileStrip files={files.data?.files ?? []} pending={files.isPending} count={p.attachments?.length ?? 0} />
      )}
      {tool.data && tool.data.tools.length > 0 && <JobTool itemId={item.id} view={tool.data} open={open} />}
      {open && (item.state === "received" || item.state === "quoted" || item.state === "needs_info") && (
        <StagedQuote item={item} currency={p.budget?.currency ?? currency} />
      )}
      {p.quote && (p.quote.stages?.length || p.quote.callOutFee || p.quote.tax || p.quote.kind) && (
        <QuoteTerms quote={p.quote} tz={tz} />
      )}
    </section>
  );
}

function FileStrip({ files, pending, count }: { files: readonly FileView[]; pending: boolean; count: number }) {
  if (pending) {
    return (
      <div className="job-files" aria-busy="true">
        {Array.from({ length: Math.min(count, 6) }, (_, i) => (
          <span key={String(i)} className="job-thumb skeleton" />
        ))}
      </div>
    );
  }
  return (
    <ul className="job-files" aria-label="Photos and plans">
      {files.map((f) => (
        <li key={f.id}>
          <a href={f.url} target="_blank" rel="noopener noreferrer" className="job-thumb" title={f.name}>
            {f.content_type === "application/pdf" ? (
              <span className="job-pdf">
                <FileText className="icon" aria-hidden="true" />
                <span className="job-pdf-name">{f.name}</span>
              </span>
            ) : (
              <img src={f.url} alt={f.name} loading="lazy" decoding="async" />
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

function JobTool({
  itemId,
  view,
  open,
}: {
  itemId: string;
  view: NonNullable<ReturnType<typeof useJobTool>["data"]>;
  open: boolean;
}) {
  const send = useSendToJobTool(itemId);
  const tool = view.tools[0];
  if (!tool) return null;
  const sent = view.sent.find((s) => s.connection_id === tool.id);
  const name = toolName(tool.kind);
  if (sent?.outcome === "written") {
    return (
      <p className="hint job-tool">
        In {name}
        {sent.url && (
          <>
            {" · "}
            <a href={sent.url} target="_blank" rel="noopener noreferrer">
              Open <ExternalLink className="icon-xs" aria-hidden="true" />
            </a>
          </>
        )}
      </p>
    );
  }
  if (sent?.outcome === "unknown" || sent?.outcome === "pending")
    return <p className="hint job-tool">Sending to {name}…</p>;
  if (view.mode === "never" || !open) return null;
  return (
    <div className="job-tool">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={send.isPending}
        onClick={() => send.mutate()}
      >
        <Send className="icon-sm" aria-hidden="true" />
        {send.isPending ? "Sending…" : `Send to ${name}`}
      </button>
      {sent?.outcome === "refused" && <span className="hint error"> {name} did not take it last time.</span>}
      {send.error && <span className="hint error"> {problemOf(send.error).detail}</span>}
      {send.data?.outcomes.some((o) => o.status === "refused") && (
        <span className="hint error"> {send.data.outcomes.find((o) => o.status === "refused")?.note}</span>
      )}
    </div>
  );
}

interface StageDraft {
  readonly key: string;
  label: string;
  amount: string;
  type: "immediate" | "deferred" | "at_property";
  due: string;
}

let stageSeq = 0;
const newStage = (label: string, type: StageDraft["type"]): StageDraft => ({
  key: `s${++stageSeq}`,
  label,
  amount: "",
  type,
  due: "",
});

/**
 * A quote in stages: estimate or fixed, the total, up to four stages that add up to it (a deposit now,
 * a stage by a date, the balance on the day), a call-out fee taken off or not, and whether tax is in.
 * Sent as the item's own quote, with every check the server makes.
 */
function StagedQuote({ item, currency }: { item: ItemOf<"quote_request">; currency: string }) {
  const transition = useTransition(item.id);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"estimate" | "fixed">("fixed");
  const [total, setTotal] = useState(item.payload.quote ? moneyMajor(item.payload.quote.totalPrice) : "");
  const [stages, setStages] = useState<StageDraft[]>(() => [
    newStage("Deposit", "immediate"),
    newStage("On completion", "at_property"),
  ]);
  const [taxIn, setTaxIn] = useState(true);
  const totalMoney = parseMoney(total, currency);
  const sum = stages.reduce((n, s) => n + (parseMoney(s.amount, currency)?.value ?? 0), 0);
  const adds = totalMoney ? sum === totalMoney.value : false;
  const ready =
    totalMoney && adds && stages.every((s) => parseMoney(s.amount, currency) && (s.type !== "deferred" || s.due));
  const set = (key: string, patch: Partial<StageDraft>) =>
    setStages(stages.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  if (!open) {
    return (
      <button type="button" className="linkish job-staged-open" onClick={() => setOpen(true)}>
        Quote in stages…
      </button>
    );
  }
  const send = () => {
    if (!ready || !totalMoney) return;
    transition.mutate({
      event: "quote",
      expected_version: item.version,
      input: {
        totalPrice: totalMoney,
        kind,
        stages: stages.map((s, i) => ({
          id: `stage-${i + 1}`,
          type: s.type,
          amount: parseMoney(s.amount, currency),
          ...(s.label.trim() ? { label: s.label.trim() } : {}),
          ...(s.type === "deferred" && s.due ? { due_at: new Date(`${s.due}T12:00:00`).toISOString() } : {}),
        })),
        tax: { included: taxIn },
      },
    });
  };
  return (
    <div className="job-staged stack">
      <fieldset className="seg">
        <legend className="sr-only">Estimate or fixed price</legend>
        <button type="button" aria-pressed={kind === "fixed"} onClick={() => setKind("fixed")}>
          Fixed price
        </button>
        <button type="button" aria-pressed={kind === "estimate"} onClick={() => setKind("estimate")}>
          Estimate
        </button>
      </fieldset>
      <label className="label" htmlFor="job-total">
        Total
      </label>
      <MoneyInput id="job-total" value={total} onChange={setTotal} currency={currency} />
      <ol className="job-stages">
        {stages.map((s) => (
          <li key={s.key} className="job-stage">
            <input
              className="input"
              aria-label="What this stage is"
              value={s.label}
              onChange={(e) => set(s.key, { label: e.target.value })}
            />
            <MoneyInput
              id={`job-${s.key}`}
              value={s.amount}
              onChange={(v) => set(s.key, { amount: v })}
              currency={currency}
              placeholder={s.label || "Amount"}
            />
            <select
              className="input"
              aria-label={`${s.label || "Stage"}: when`}
              value={s.type}
              onChange={(e) => set(s.key, { type: e.target.value as StageDraft["type"] })}
            >
              {(["immediate", "deferred", "at_property"] as const).map((t) => (
                <option key={t} value={t}>
                  {stageWhen(t)}
                </option>
              ))}
            </select>
            {s.type === "deferred" && (
              <input
                className="input"
                type="date"
                aria-label={`${s.label || "Stage"}: due by`}
                value={s.due}
                onChange={(e) => set(s.key, { due: e.target.value })}
              />
            )}
            {stages.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={`Remove ${s.label || "this stage"}`}
                onClick={() => setStages(stages.filter((x) => x.key !== s.key))}
              >
                <X className="icon-sm" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ol>
      {stages.length < 4 && (
        <button
          type="button"
          className="linkish"
          onClick={() => setStages([...stages.slice(0, -1), newStage("Stage", "deferred"), ...stages.slice(-1)])}
        >
          <Plus className="icon-xs" aria-hidden="true" /> A stage
        </button>
      )}
      <p className={clsx("hint", totalMoney && !adds && "error")} role="status">
        {totalMoney
          ? adds
            ? "The stages add up to the total."
            : `The stages add up to ${formatMoney({ value: sum, currency })} of ${formatMoney(totalMoney)}.`
          : "Write the total first."}
      </p>
      <label className="check">
        <input type="checkbox" checked={taxIn} onChange={(e) => setTaxIn(e.target.checked)} /> Prices include tax
      </label>
      {transition.error && <p className="hint error">{problemOf(transition.error).detail}</p>}
      <div className="actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!ready || transition.isPending}
          onClick={send}
        >
          {transition.isPending ? "Sending…" : "Send quote"}
        </button>
      </div>
    </div>
  );
}

function QuoteTerms({
  quote,
  tz,
}: {
  quote: NonNullable<ItemOf<"quote_request">["payload"]["quote"]>;
  tz: string | undefined;
}) {
  return (
    <dl className="fields job-terms">
      {quote.kind && (
        <div>
          <dt>Price</dt>
          <dd>{quote.kind === "estimate" ? "An estimate" : "Fixed"}</dd>
        </div>
      )}
      {quote.stages?.length ? (
        <div className="wide">
          <dt>Stages</dt>
          <dd>
            <ul className="job-windows">
              {quote.stages.map((s) => (
                <li key={s.id}>
                  {s.label ? `${s.label}: ` : ""}
                  {formatMoney(s.amount)} ·{" "}
                  {s.type === "deferred" && s.due_at
                    ? `by ${formatDay(s.due_at, tz)}`
                    : stageWhen(s.type).toLowerCase()}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
      {quote.callOutFee && (
        <div>
          <dt>Call-out</dt>
          <dd>
            {formatMoney(quote.callOutFee.amount)}
            {quote.callOutFee.creditedIfAccepted ? ", taken off if accepted" : ""}
          </dd>
        </div>
      )}
      {quote.tax && (
        <div>
          <dt>Tax</dt>
          <dd>{quote.tax.included ? "Included" : "On top"}</dd>
        </div>
      )}
    </dl>
  );
}
