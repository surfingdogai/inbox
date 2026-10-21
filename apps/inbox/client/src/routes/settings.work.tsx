import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { MoneyInput, Stepper } from "../components/Choosers";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, FormActions, SectionHead, Switch } from "../components/Form";
import { moneyMajor, parseMoney } from "../lib/actions";
import { type ApiProblem, problemOf } from "../lib/api";
import { formatDay } from "../lib/format";
import { qk, useSaveSettings, useServices, useSettings } from "../lib/queries";
import { MODE_WORDS, toolName, useWork, type WorkDoc } from "../lib/trades";
import type { SettingsDoc } from "../lib/types";
import "../trades.css";

export const Route = createFileRoute("/settings/work")({
  component: WorkPage,
});

/**
 * Settings → Work (ADR-034 §4): how a trade takes work. What coming out costs, what a visit outside
 * opening hours adds, whether agents may ask for an emergency job, free estimates, the service a site
 * visit is booked as, and which requests go into the owner's job tool. Choices, never typed codes;
 * only the owner in person changes them.
 */
function WorkPage() {
  const settings = useSettings();
  const qc = useQueryClient();
  const [round, setRound] = useState(0);
  if (settings.isPending) {
    return (
      <div className="card glass" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div className="card glass">
        <ErrorState
          title="Could not load the settings"
          text={problemOf(settings.error).detail}
          onRetry={() => void settings.refetch()}
        />
      </div>
    );
  }
  const reload = () => void qc.invalidateQueries({ queryKey: qk.settings }).then(() => setRound((r) => r + 1));
  return <WorkForm key={round} data={settings.data} onReload={reload} />;
}

type Surcharge = "none" | "amount" | "percent";

function WorkForm({ data, onReload }: { data: SettingsDoc; onReload: () => void }) {
  const save = useSaveSettings();
  const services = useServices();
  const work = useWork();
  const qc = useQueryClient();
  const doc = data.doc as SettingsDoc["doc"] & { work: WorkDoc };
  const w = doc.work;
  const currency = doc.business.currency;
  const [callOut, setCallOut] = useState(w.callOutFee ? moneyMajor(w.callOutFee.amount) : "");
  const [credited, setCredited] = useState(w.callOutFee?.creditedIfAccepted ?? true);
  const [surcharge, setSurcharge] = useState<Surcharge>(w.outOfHours?.surcharge.kind ?? "none");
  const [amount, setAmount] = useState(
    w.outOfHours?.surcharge.kind === "amount" ? moneyMajor(w.outOfHours.surcharge.amount) : "",
  );
  const [percent, setPercent] = useState(
    w.outOfHours?.surcharge.kind === "percent" ? String(w.outOfHours.surcharge.percent) : "25",
  );
  const [emergency, setEmergency] = useState<WorkDoc["emergency"]>(w.emergency);
  const [estimates, setEstimates] = useState(w.freeEstimates);
  const [visit, setVisit] = useState<string>(w.visitServiceId ?? "");
  const [mode, setMode] = useState<WorkDoc["jobTool"]>(w.jobTool);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [saved, setSaved] = useState(false);

  const callOutMoney = callOut.trim() ? parseMoney(callOut, currency) : undefined;
  const amountMoney = amount.trim() ? parseMoney(amount, currency) : undefined;
  const callOutBad = callOut.trim() !== "" && !callOutMoney;
  const amountBad = surcharge === "amount" && !amountMoney;

  const submit = async () => {
    setProblem(null);
    setSaved(false);
    if (callOutBad || amountBad) return;
    try {
      await save.mutateAsync({
        doc: {
          work: {
            callOutFee: callOutMoney ? { amount: callOutMoney, creditedIfAccepted: credited } : null,
            outOfHours:
              surcharge === "amount" && amountMoney
                ? { surcharge: { kind: "amount", amount: amountMoney } }
                : surcharge === "percent"
                  ? { surcharge: { kind: "percent", percent: Math.max(1, Math.min(300, Number(percent) || 25)) } }
                  : null,
            emergency,
            freeEstimates: estimates,
            visitServiceId: visit || null,
            jobTool: mode,
          },
        },
        expected_version: data.version,
      });
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["work"] });
    } catch (e) {
      setProblem(problemOf(e));
    }
  };

  const tools = work.data?.job_tools ?? [];
  return (
    <div className="stack">
      <section className="card glass stack work">
        <SectionHead title="Coming out" />
        <Field id="work-callout" label="Call-out fee" optional error={callOutBad ? "An amount, like 45" : undefined}>
          <MoneyInput
            id="work-callout"
            value={callOut}
            onChange={setCallOut}
            currency={currency}
            invalid={callOutBad}
          />
        </Field>
        {callOutMoney && (
          <Switch checked={credited} onChange={setCredited}>
            Taken off the price when they accept the quote
          </Switch>
        )}
        <fieldset className="chips-field">
          <legend className="label">Outside opening hours, a visit adds</legend>
          <fieldset className="seg">
            <legend className="sr-only">Outside opening hours</legend>
            {(
              [
                ["none", "Nothing"],
                ["amount", "An amount"],
                ["percent", "A share"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={surcharge === k} onClick={() => setSurcharge(k)}>
                {label}
              </button>
            ))}
          </fieldset>
        </fieldset>
        {surcharge === "amount" && (
          <Field id="work-ooh" label="Added" error={amountBad ? "An amount, like 30" : undefined}>
            <MoneyInput id="work-ooh" value={amount} onChange={setAmount} currency={currency} invalid={amountBad} />
          </Field>
        )}
        {surcharge === "percent" && (
          <Stepper id="work-ooh-pct" label="Added" value={percent} onChange={setPercent} min={1} max={300} suffix="%" />
        )}
        <p className="hint">
          Opening hours are in <Link to="/settings/availability">Availability</Link>.
        </p>
      </section>

      <section className="card glass stack work">
        <SectionHead title="Emergencies" />
        <fieldset className="seg">
          <legend className="sr-only">Emergency jobs from agents</legend>
          {(
            [
              ["off", "Not online"],
              ["opening_hours", "While open"],
              ["always", "Any hour"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={emergency === k} onClick={() => setEmergency(k)}>
              {label}
            </button>
          ))}
        </fieldset>
        <p className="hint">
          {emergency === "off"
            ? "Agents are told to ask within 24 hours, or to call you."
            : "Only inside your area. Emergencies come first in your inbox."}
        </p>
        <Switch checked={estimates} onChange={setEstimates}>
          Estimates are free
        </Switch>
      </section>

      <section className="card glass stack work">
        <SectionHead title="Site visits" />
        <Field
          id="work-visit"
          label="A visit is booked as"
          optional
          hint="Agents book it beside the request it is for; you confirm it."
        >
          <select id="work-visit" className="input" value={visit} onChange={(e) => setVisit(e.target.value)}>
            <option value="">No service</option>
            {(services.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="card glass stack work">
        <SectionHead title="Your job tool" />
        <fieldset className="seg">
          <legend className="sr-only">Which requests go into your job tool</legend>
          {(Object.keys(MODE_WORDS) as WorkDoc["jobTool"][]).map((k) => (
            <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>
              {MODE_WORDS[k].label}
            </button>
          ))}
        </fieldset>
        <p className="hint">{MODE_WORDS[mode].line}</p>
        {tools.length > 0 ? (
          <p className="hint">
            Connected: {tools.map((t) => toolName(t.kind)).join(", ")} ·{" "}
            <Link to="/settings/integrations">Integrations</Link>
          </p>
        ) : (
          <p className="hint">
            No job tool yet: <Link to="/settings/integrations">connect ServiceM8, Housecall Pro or Fergus</Link>.
          </p>
        )}
        {(work.data?.expiring ?? []).map((x) => (
          <p key={x.connection_id} className="hint work-expiring">
            Your {toolName(x.kind)} token runs out on {formatDay(x.expires_at)}. Make a new one and connect again.
          </p>
        ))}
      </section>

      {problem && <Toast tone="danger" text={problem.detail} onDismiss={() => setProblem(null)} />}
      {problem?.code === "version_conflict" && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReload}>
          Reload
        </button>
      )}
      <FormActions>
        {saved && (
          <span className="hint" role="status">
            Saved
          </span>
        )}
        <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => void submit()}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </FormActions>
    </div>
  );
}
