import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { MoneyInput, Stepper } from "../components/Choosers";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, FormActions, SectionHead, Switch } from "../components/Form";
import { moneyMajor, parseMoney } from "../lib/actions";
import { type ApiProblem, problemOf } from "../lib/api";
import { formatDay } from "../lib/format";
import { describeWeekly } from "../lib/hours";
import {
  qk,
  useAvailability,
  useSaveSettings,
  useSaveWeekly,
  useServices,
  useServiceWrite,
  useSettings,
} from "../lib/queries";
import { MODE_WORDS, sameWeek, type ToolSetupView, toolName, tradesApi, useWork, type WorkDoc } from "../lib/trades";
import type { SettingsDoc } from "../lib/types";
import { zoneName } from "../lib/zones";
import "../trades.css";

export const Route = createFileRoute("/settings/work")({
  component: WorkPage,
});

/**
 * Settings → Work (ADR-034 §4): how a trade takes work. The call-out fee, what a visit outside opening
 * hours adds, free estimates, whether agents may ask for an emergency job, the service a site visit is
 * booked as, and which requests go into the owner's job tool. Choices, never typed codes; only the
 * owner in person changes them.
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
  const addService = useServiceWrite();
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
  const visitServices = services.data?.items ?? [];
  // One press: a site visit of an hour, free, that the owner confirms (visits are always on request).
  const addVisit = async () => {
    try {
      const row = await addService.mutateAsync({
        body: { name: "Site visit", duration_min: 60, active: true, price: { model: "fixed", value: 0, currency } },
      });
      setVisit(row.id);
    } catch {
      // Said under the button, from the mutation's own error.
    }
  };
  return (
    <div className="stack">
      <section className="card glass stack work">
        <SectionHead title="Call-outs" />
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
                ["amount", "Fixed amount"],
                ["percent", "Percentage"],
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
        <Switch checked={estimates} onChange={setEstimates}>
          Estimates are free
        </Switch>
      </section>

      <section className="card glass stack work">
        <SectionHead title="Emergencies" />
        <fieldset className="seg">
          <legend className="sr-only">Emergency jobs from agents</legend>
          {(
            [
              ["off", "Off"],
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
            ? "Agents are told you don't take emergencies online: they can ask for within 24 hours, or call you."
            : "Emergencies come first in your inbox."}
        </p>
      </section>

      <section className="card glass stack work">
        <SectionHead title="Site visits" />
        {services.isSuccess && visitServices.length === 0 ? (
          <div className="stack">
            <div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={addService.isPending}
                onClick={() => void addVisit()}
              >
                {addService.isPending ? "Adding…" : "Add a Site visit service"}
              </button>
            </div>
            <p className="hint">An hour, free, and you confirm each one. Change it in Services.</p>
            {addService.isError && <p className="hint error">{problemOf(addService.error).detail}</p>}
          </div>
        ) : (
          <Field
            id="work-visit"
            label="A visit is booked as"
            optional
            hint="Agents book it beside the request it is for; you confirm it."
          >
            <select id="work-visit" className="input" value={visit} onChange={(e) => setVisit(e.target.value)}>
              <option value="">No service</option>
              {visitServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {services.isSuccess && visitServices.length > 0 && !visit && (
          <p className="hint">
            Or add one in <Link to="/settings/services">Services</Link>.
          </p>
        )}
      </section>

      <section className="card glass stack work">
        <SectionHead title="Your job tool" />
        {tools.length > 0 ? (
          <>
            <fieldset className="seg">
              <legend className="sr-only">Which requests go into your job tool</legend>
              {(Object.keys(MODE_WORDS) as WorkDoc["jobTool"][]).map((k) => (
                <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>
                  {MODE_WORDS[k].label}
                </button>
              ))}
            </fieldset>
            <p className="hint">{MODE_WORDS[mode].line}</p>
            {mode === "every" && tools.some((t) => t.kind === "servicem8") && (
              <p className="hint">ServiceM8 may charge for each job it makes, and every request becomes one.</p>
            )}
            <p className="hint">
              Connected: {tools.map((t) => toolName(t.kind)).join(", ")} ·{" "}
              <Link to="/settings/integrations">Integrations</Link>
            </p>
          </>
        ) : (
          <p className="hint">
            No job tool yet: connect one, such as ServiceM8, in <Link to="/settings/integrations">Integrations</Link>.
          </p>
        )}
        {tools
          .filter((t) => t.starts)
          .map((t) => (
            <StartFromTool key={t.id} id={t.id} kind={t.kind} zone={doc.business.timezone} />
          ))}
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

/**
 * "Start from your tool" (ADR-034 §5): the opening hours a job tool keeps, read when the owner asks,
 * shown beside the inbox's own, and kept only when they press. Hours from a tool in another time zone
 * are shown, never kept as they are: Availability is where they are set then.
 */
function StartFromTool({ id, kind, zone }: { id: string; kind: string; zone: string }) {
  const name = toolName(kind);
  const ours = useAvailability();
  const keep = useSaveWeekly();
  const [read, setRead] = useState<ToolSetupView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const look = async () => {
    setProblem(null);
    setBusy(true);
    try {
      setRead(await tradesApi.setup(id));
    } catch (e) {
      setProblem(problemOf(e).detail);
    } finally {
      setBusy(false);
    }
  };
  if (!read) {
    return (
      <div className="work-start">
        <button type="button" className="linkish" disabled={busy} onClick={() => void look()}>
          {busy ? `Reading ${name}…` : `Copy opening hours from ${name}`}
        </button>
        {problem && <p className="hint error">{problem}</p>}
      </div>
    );
  }
  const theirs = read.hours ?? {};
  const elsewhere = read.source.zone && read.source.zone !== zone ? read.source.zone : null;
  const same = ours.data ? sameWeek(ours.data.weekly, theirs) : false;
  return (
    <div className="work-start stack">
      <p className="hint">
        {name}: {describeWeekly(theirs)}
        {ours.data && (
          <>
            <br />
            Yours now: {describeWeekly(ours.data.weekly)}
          </>
        )}
      </p>
      {elsewhere ? (
        <p className="hint">
          {name} keeps its hours in {zoneName(elsewhere)}, and this inbox is in {zoneName(zone)}: set yours in{" "}
          <Link to="/settings/availability">Availability</Link>.
        </p>
      ) : keep.isSuccess || same ? (
        <p className="hint" role="status">
          Your opening hours match {name}.
        </p>
      ) : (
        <div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={keep.isPending || Object.keys(theirs).length === 0}
            onClick={() => keep.mutate({ weekly: theirs })}
          >
            {keep.isPending ? "Saving…" : "Use these hours"}
          </button>
        </div>
      )}
      {keep.isError && <p className="hint error">{problemOf(keep.error).detail}</p>}
    </div>
  );
}
