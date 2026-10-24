import type { DepositRule, Policy } from "@surfingdog/core";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { majorText, parseMajor } from "../lib/actions";
import { problemOf } from "../lib/api";
import { minorUnitsOf } from "../lib/currencies";
import { formatMoney } from "../lib/format";
import { useIntegrations, useServiceWrite } from "../lib/queries";
import { DEPOSIT_PRESETS, depositKey, POLICY_PRESETS, percentText, policyKey, policyWords } from "../lib/staff";
import type { ServiceBody, ServiceRow } from "../lib/types";
import { DurationPicker, MoneyInput } from "./Choosers";
import { Field, FormActions } from "./Form";

/**
 * A service's terms (ADR-035): what can be added to it ("+ blow-dry, 15 min"), the deposit that holds a
 * booking (only once a payment platform can ask for it), its own cancellation policy (presets first,
 * each said in full under the chips), and what must come first (a patch test, at least 48 hours before
 * and within so many days). Customers read the add-ons, the deposit and the policy before they confirm;
 * what comes first is checked, never shown. A deposit or policy set elsewhere is kept as it is.
 */

type Terms = ServiceRow & {
  readonly addOns?:
    | { id: string; name: string; durationMin: number; price?: { value: number; currency: string } }[]
    | null;
  readonly deposit?: DepositRule | null;
  readonly policy?: Policy | null;
  readonly requires?: { serviceId: string; withinDays: number; atLeastHours?: number } | null;
};

/** The terms in a few words, under the service's name: "1 add-on · 30% deposit · … · after Patch test (180 days)". */
export function termsLine(s: ServiceRow, currency: string, services: readonly ServiceRow[] = []): string {
  const t = s as Terms;
  const out: string[] = [];
  if (t.addOns?.length) out.push(`${t.addOns.length} add-on${t.addOns.length === 1 ? "" : "s"}`);
  if (t.deposit)
    out.push(
      t.deposit.kind === "percent"
        ? `${percentText(t.deposit.value)} deposit`
        : `${formatMoney({ value: t.deposit.value, currency: s.price?.currency ?? currency })} deposit`,
    );
  if (t.policy) out.push(policyWords(t.policy));
  if (t.requires) {
    const first = services.find((x) => x.id === t.requires?.serviceId)?.name ?? "another service";
    out.push(`after ${first} (${t.requires.withinDays} days)`);
  }
  return out.join(" · ");
}

const ADD_LENGTHS = [
  { value: 10, label: "10 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
];
// A patch test stays good for months, and is read two days on: the windows start at a month.
const WITHIN = [
  { value: 30, label: "30 days" },
  { value: 180, label: "6 months" },
  { value: 365, label: "A year" },
];

export function ServiceTerms({
  service,
  services,
  currency,
  onDone,
  onCancel,
}: {
  service: ServiceRow;
  services: readonly ServiceRow[];
  currency: string;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const t = service as Terms;
  const money = service.price?.currency ?? currency;
  const write = useServiceWrite();
  // A deposit is asked by a link on the business's own payment platform: without one, nothing would.
  const integrations = useIntegrations();
  const payments = (integrations.data?.connections ?? []).some((c) => c.pay_on === true);
  const [addOns, setAddOns] = useState(
    (t.addOns ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      length: String(a.durationMin),
      price: a.price ? majorText(a.price.value, a.price.currency) : "",
    })),
  );
  const [deposit, setDeposit] = useState(depositKey(t.deposit));
  const [fixed, setFixed] = useState(t.deposit?.kind === "amount" ? majorText(t.deposit.value, money) : "");
  const [policy, setPolicy] = useState(policyKey(t.policy));
  const [first, setFirst] = useState(t.requires?.serviceId ?? "");
  const [within, setWithin] = useState(String(t.requires?.withinDays ?? 180));
  const others = services.filter((s) => s.id !== service.id && s.active === 1);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const rule: DepositRule | null =
      deposit === "custom"
        ? (t.deposit ?? null)
        : deposit === "fixed"
          ? { kind: "amount", value: parseMajor(fixed, minorUnitsOf(money)) ?? 0 }
          : (DEPOSIT_PRESETS.find((p) => p.key === deposit)?.rule ?? null);
    const chosen =
      policy === "custom" ? (t.policy ?? null) : (POLICY_PRESETS.find((p) => p.key === policy)?.policy ?? null);
    const body = {
      add_ons: addOns
        .filter((a) => a.name.trim())
        .map((a) => ({
          ...(a.id ? { id: a.id } : {}),
          name: a.name.trim(),
          duration_min: Number(a.length || 0),
          ...(a.price.trim()
            ? { price: { value: parseMajor(a.price, minorUnitsOf(money)) ?? 0, currency: money } }
            : {}),
        })),
      deposit: rule && (rule.kind === "percent" || rule.value > 0) ? rule : null,
      policy: chosen,
      requires: first
        ? {
            service_id: first,
            within_days: Number(within),
            ...(t.requires?.atLeastHours !== undefined ? { at_least_hours: t.requires.atLeastHours } : {}),
          }
        : null,
    };
    write.mutate(
      { id: service.id, body: body as unknown as ServiceBody },
      { onSuccess: () => onDone(`${service.name}: terms saved.`) },
    );
  };
  return (
    <form className="stack" onSubmit={submit}>
      <fieldset className="chips-field">
        <legend className="label">Add-ons</legend>
        {addOns.map((a, i) => (
          <div key={a.id || `new-${i}`} className="staff-terms row-glass">
            <Field id={`${id}-a${i}`} label="Name">
              <input
                id={`${id}-a${i}`}
                className="input"
                value={a.name}
                maxLength={120}
                placeholder="Blow-dry"
                onChange={(e) => setAddOns((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))}
              />
            </Field>
            <DurationPicker
              id={`${id}-l${i}`}
              legend="Adds"
              value={a.length}
              unit="min"
              presets={ADD_LENGTHS}
              min={0}
              max={480}
              onChange={(length) => setAddOns((x) => x.map((y, j) => (j === i ? { ...y, length } : y)))}
            />
            <div className="rowx">
              <Field id={`${id}-p${i}`} label="Costs" optional>
                <MoneyInput
                  id={`${id}-p${i}`}
                  value={a.price}
                  currency={money}
                  onChange={(price) => setAddOns((x) => x.map((y, j) => (j === i ? { ...y, price } : y)))}
                />
              </Field>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                aria-label={`Remove ${a.name || "this add-on"}`}
                onClick={() => setAddOns((x) => x.filter((_, j) => j !== i))}
              >
                <Trash2 className="icon-sm" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setAddOns((x) => [...x, { id: "", name: "", length: "15", price: "" }])}
          >
            <Plus className="icon-sm" aria-hidden="true" />
            Add an add-on
          </button>
        </div>
      </fieldset>

      <fieldset className="chips-field">
        <legend className="label">Deposit</legend>
        <div className="chips" role="radiogroup">
          {DEPOSIT_PRESETS.map((p) => (
            <label key={p.key} className={`chip${p.rule && !payments ? " is-disabled" : ""}`}>
              <input
                type="radio"
                name={`${id}-dep`}
                checked={deposit === p.key}
                disabled={p.rule !== null && !payments}
                onChange={() => setDeposit(p.key)}
              />
              <span>{p.label}</span>
            </label>
          ))}
          {deposit === "custom" && t.deposit && (
            <label className="chip">
              <input type="radio" name={`${id}-dep`} checked readOnly />
              <span>
                As set:{" "}
                {t.deposit.kind === "percent"
                  ? percentText(t.deposit.value)
                  : formatMoney({ value: t.deposit.value, currency: money })}
              </span>
            </label>
          )}
        </div>
        {deposit === "fixed" && <MoneyInput id={`${id}-fixed`} value={fixed} currency={money} onChange={setFixed} />}
        {payments ? (
          <p className="hint">Paid on your own payment platform when a booking is confirmed. The rest at the visit.</p>
        ) : (
          <p className="hint">
            To ask for a deposit, connect Stripe or Mollie in <a href="/settings/integrations">Integrations</a>.
          </p>
        )}
      </fieldset>

      <fieldset className="chips-field">
        <legend className="label">Cancelling</legend>
        <div className="chips" role="radiogroup">
          {POLICY_PRESETS.map((p) => (
            <label key={p.key} className="chip">
              <input type="radio" name={`${id}-pol`} checked={policy === p.key} onChange={() => setPolicy(p.key)} />
              <span>{p.label}</span>
            </label>
          ))}
          {policy === "custom" && (
            <label className="chip">
              <input type="radio" name={`${id}-pol`} checked readOnly />
              <span>As set</span>
            </label>
          )}
        </div>
        {/* What the chosen one charges, every fee of it, before it is saved. */}
        {(() => {
          const chosen = policy === "custom" ? t.policy : POLICY_PRESETS.find((p) => p.key === policy)?.policy;
          const words = policyWords(chosen);
          return words ? <p className="terms-words">{words[0]?.toUpperCase() + words.slice(1)}.</p> : null;
        })()}
        <p className="hint">
          Customers see it, dated, before they confirm. Some places limit cancellation fees: check yours.
        </p>
      </fieldset>

      <fieldset className="chips-field">
        <legend className="label">Comes after</legend>
        <div className="chips" role="radiogroup">
          <label className="chip">
            <input type="radio" name={`${id}-req`} checked={first === ""} onChange={() => setFirst("")} />
            <span>Nothing first</span>
          </label>
          {others.map((s) => (
            <label key={s.id} className="chip">
              <input type="radio" name={`${id}-req`} checked={first === s.id} onChange={() => setFirst(s.id)} />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
        {first && (
          <DurationPicker
            id={`${id}-within`}
            legend="Within"
            value={within}
            unit="days"
            presets={WITHIN}
            min={1}
            max={730}
            onChange={setWithin}
          />
        )}
        <p className="hint">
          {first
            ? `At least ${t.requires?.atLeastHours ?? 48} h before, within the days you choose. Checked against your own bookings with that client; nobody is shown anyone's records.`
            : "Checked against your own bookings with that client. Nobody is shown anyone's records."}
        </p>
      </fieldset>
      {write.error && (
        <p className="hint error" role="alert">
          {problemOf(write.error).detail}
        </p>
      )}
      <FormActions>
        <button type="submit" className="btn btn-primary" disabled={write.isPending}>
          Save terms
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={write.isPending}>
          Cancel
        </button>
      </FormActions>
    </form>
  );
}
