import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { MoneyInput, Stepper } from "../components/Choosers";
import { ErrorState, Toast } from "../components/Feedback";
import { FormActions, SectionHead, Switch } from "../components/Form";
import { majorText, parseMoney } from "../lib/actions";
import { type ApiProblem, problemOf } from "../lib/api";
import { foodApi, type KitchenDoc, type TablesDraft, tablesWrite } from "../lib/food";
import { formatMoney } from "../lib/format";
import { countryOfZone } from "../lib/geo";
import { qk, useSaveSettings, useServices, useSettings } from "../lib/queries";
import { normalisePrefix } from "../lib/trades";
import type { Money, ServiceRow, SettingsDoc } from "../lib/types";
import "../food.css";
import "../trades.css";

export const Route = createFileRoute("/settings/kitchen")({
  component: KitchenPage,
});

const PREP_CHIPS = [10, 15, 20, 30, 45, 60] as const;
const SLOT_CHIPS = [10, 15, 30, 60] as const;
const AHEAD_CHIPS = [
  [0, "Today only"],
  [1, "Tomorrow"],
  [3, "3 days"],
  [7, "A week"],
  [14, "2 weeks"],
] as const;
const TIP_CHIPS = [5, 10, 12, 15, 18, 20] as const;
const RING_CHIPS = [1, 2, 3, 5, 8, 12] as const;
const ETA_CHIPS = [20, 30, 45, 60] as const;

/**
 * Settings → Kitchen (ADR-036): how orders are taken for a time. Collection, delivery in zones, eating
 * in; how long the kitchen needs; slots and how many each takes here; who accepts; tips on the
 * business's own pay link; and tables booked by covers. Every one a choice, never a code.
 */
function KitchenPage() {
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
  return (
    <div className="stack kitchen-page">
      <KitchenForm key={`k${round}`} data={settings.data} onReload={reload} />
      <ZonesForm key={`z${round}`} data={settings.data} onReload={reload} />
      <Tables />
    </div>
  );
}

function KitchenForm({ data, onReload }: { data: SettingsDoc; onReload: () => void }) {
  const save = useSaveSettings();
  const k = (data.doc as unknown as { kitchen: KitchenDoc }).kitchen;
  const [enabled, setEnabled] = useState(k.enabled);
  const [methods, setMethods] = useState(k.methods);
  const [prep, setPrep] = useState(String(k.prepMin));
  const [slot, setSlot] = useState<KitchenDoc["slotMin"]>(k.slotMin);
  const [perSlot, setPerSlot] = useState(String(k.perSlot));
  const [ahead, setAhead] = useState(k.daysAhead);
  const [accept, setAccept] = useState(k.accept);
  const [tips, setTips] = useState(k.tips);
  const [pausePos, setPausePos] = useState(k.pausePos);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [saved, setSaved] = useState(false);
  const customPrep = !PREP_CHIPS.some((p) => String(p) === prep);

  const submit = async () => {
    setProblem(null);
    setSaved(false);
    try {
      await save.mutateAsync({
        doc: {
          // The pause is pressed on the inbox's home, not saved from here: left as it is.
          kitchen: {
            enabled,
            methods,
            prepMin: Math.max(0, Math.min(240, Number(prep) || 0)),
            slotMin: slot,
            perSlot: Math.max(1, Math.min(200, Number(perSlot) || 1)),
            daysAhead: ahead,
            accept,
            tips: { enabled: tips.enabled, choices: tips.choices.length ? [...tips.choices] : [10] },
            pausePos,
          },
        },
        expected_version: data.version,
      });
      setSaved(true);
    } catch (e) {
      setProblem(problemOf(e));
    }
  };

  return (
    <section className="card glass stack">
      <SectionHead title="Orders for a time" />
      <p className="lede small">
        Agents offer the slots your kitchen can make, inside your opening hours. Nothing is sold twice here.
      </p>
      <Switch checked={enabled} onChange={setEnabled}>
        Take orders for a time: collection, delivery, eating in
      </Switch>
      {enabled && (
        <>
          <fieldset className="chips-field">
            <legend className="label">How people get it</legend>
            <div className="chips">
              {(
                [
                  ["pickup", "Collection"],
                  ["delivery", "Delivery"],
                  ["dineIn", "Eat in"],
                ] as const
              ).map(([m, w]) => (
                <button
                  key={m}
                  type="button"
                  className="chip"
                  aria-pressed={methods[m]}
                  onClick={() => setMethods({ ...methods, [m]: !methods[m] })}
                >
                  {w}
                </button>
              ))}
            </div>
            {methods.delivery && (
              <p className="hint">Delivery is offered in the zones below. Your own drivers: no courier is called.</p>
            )}
          </fieldset>

          <fieldset className="chips-field">
            <legend className="label">The kitchen needs</legend>
            <div className="chips">
              {PREP_CHIPS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="chip"
                  aria-pressed={prep === String(p)}
                  onClick={() => setPrep(String(p))}
                >
                  {p} min
                </button>
              ))}
              <button type="button" className="chip" aria-pressed={customPrep} onClick={() => setPrep("90")}>
                Other
              </button>
            </div>
            {customPrep && (
              <Stepper
                id="kitchen-prep"
                label="Minutes"
                value={prep}
                onChange={setPrep}
                min={0}
                max={240}
                suffix="min"
              />
            )}
          </fieldset>

          <div className="grid2">
            <fieldset className="chips-field">
              <legend className="label">Slots of</legend>
              <div className="chips">
                {SLOT_CHIPS.map((s) => (
                  <button key={s} type="button" className="chip" aria-pressed={slot === s} onClick={() => setSlot(s)}>
                    {s} min
                  </button>
                ))}
              </div>
            </fieldset>
            <Stepper
              id="kitchen-per-slot"
              label="Orders a slot takes here"
              value={perSlot}
              onChange={setPerSlot}
              min={1}
              max={200}
              hint="What you set aside for orders through here, on top of the till."
            />
          </div>

          <fieldset className="chips-field">
            <legend className="label">How far ahead</legend>
            <div className="chips">
              {AHEAD_CHIPS.map(([d, w]) => (
                <button key={d} type="button" className="chip" aria-pressed={ahead === d} onClick={() => setAhead(d)}>
                  {w}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="chips-field">
            <legend className="label">Who accepts</legend>
            <fieldset className="seg">
              <legend className="sr-only">Who accepts</legend>
              <button type="button" aria-pressed={accept === "owner"} onClick={() => setAccept("owner")}>
                I accept each
              </button>
              <button type="button" aria-pressed={accept === "caps"} onClick={() => setAccept("caps")}>
                At once, inside what I set aside
              </button>
            </fieldset>
            <p className="hint">
              {accept === "caps"
                ? "An order inside the slot's places and each dish's daily limit is accepted at once. Anything else waits for you, and so does any order with allergens you have not confirmed."
                : "Every order waits for you to accept it."}
            </p>
          </fieldset>

          <fieldset className="chips-field">
            <legend className="label">Tips</legend>
            <Switch checked={tips.enabled} onChange={(v) => setTips({ ...tips, enabled: v })}>
              People may add a tip, on your own pay link
            </Switch>
            {tips.enabled && (
              <div className="chips">
                {TIP_CHIPS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="chip"
                    aria-pressed={tips.choices.includes(t)}
                    onClick={() =>
                      setTips({
                        ...tips,
                        choices: tips.choices.includes(t)
                          ? tips.choices.filter((x) => x !== t)
                          : [...tips.choices, t].sort((a, b) => a - b).slice(0, 6),
                      })
                    }
                  >
                    {t}%
                  </button>
                ))}
              </div>
            )}
          </fieldset>

          <Switch checked={pausePos} onChange={setPausePos}>
            Pausing here pauses your ordering system too, where it can be
          </Switch>
        </>
      )}
      <p className="hint">
        Busy? Pause orders from the <Link to="/">inbox</Link>.
      </p>
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
    </section>
  );
}

interface ZoneDraft {
  /** The editor's own key for it, never saved. */
  readonly key: number;
  readonly name: string;
  readonly mode: "radius" | "postal";
  readonly radiusKm: number;
  readonly postal: readonly { country: string; prefix: string }[];
  readonly fee: string;
  readonly minimum: string;
  readonly etaMin: number | null;
}

type StoredZone = {
  name: string;
  mode: "radius" | "postal";
  radiusKm?: number;
  postal?: { country: string; prefix: string }[];
  fee?: Money;
  minimumOrder?: Money;
  etaMin?: number;
};

/** Delivery zones, inside out: the first an address falls in wins, with its fee, minimum and time. */
function ZonesForm({ data, onReload }: { data: SettingsDoc; onReload: () => void }) {
  const save = useSaveSettings();
  const doc = data.doc as unknown as {
    area: { zones: StoredZone[]; base: unknown };
    kitchen: KitchenDoc;
    directory: { geo?: unknown; address: { addressCountry?: string } };
    business: { currency?: string; timezone?: string };
  };
  const currency = doc.business.currency ?? "EUR";
  const country = doc.directory.address.addressCountry || countryOfZone(doc.business.timezone) || "";
  const [zones, setZones] = useState<readonly ZoneDraft[]>(
    doc.area.zones.map((z, i) => ({
      key: i + 1,
      name: z.name,
      mode: z.mode,
      radiusKm: z.radiusKm ?? 3,
      postal: z.postal ?? [],
      fee: z.fee ? majorText(z.fee.value, currency) : "",
      minimum: z.minimumOrder ? majorText(z.minimumOrder.value, currency) : "",
      etaMin: z.etaMin ?? null,
    })),
  );
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [problem, setProblem] = useState<ApiProblem | string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!doc.kitchen.enabled || !doc.kitchen.methods.delivery) return null;
  const measured = doc.area.base !== null || doc.directory.geo !== undefined;
  const set = (i: number, z: Partial<ZoneDraft>) => setZones(zones.map((x, j) => (j === i ? { ...x, ...z } : x)));

  const submit = async () => {
    setProblem(null);
    setSaved(false);
    const out: StoredZone[] = [];
    for (const z of zones) {
      const fee = z.fee.trim() ? parseMoney(z.fee, currency) : undefined;
      const minimum = z.minimum.trim() ? parseMoney(z.minimum, currency) : undefined;
      if ((z.fee.trim() && !fee) || (z.minimum.trim() && !minimum)) {
        setProblem(`${z.name || "A zone"}: an amount does not read.`);
        return;
      }
      if (z.mode === "postal" && z.postal.length === 0) {
        setProblem(`${z.name || "A zone"}: add a postal code, or measure it by distance.`);
        return;
      }
      out.push({
        name: z.name.trim() || `Zone ${out.length + 1}`,
        mode: z.mode,
        ...(z.mode === "radius" ? { radiusKm: z.radiusKm } : { postal: [...z.postal] }),
        ...(fee && fee.value > 0 ? { fee } : {}),
        ...(minimum && minimum.value > 0 ? { minimumOrder: minimum } : {}),
        ...(z.etaMin ? { etaMin: z.etaMin } : {}),
      });
    }
    try {
      await save.mutateAsync({ doc: { area: { zones: out } }, expected_version: data.version });
      setSaved(true);
    } catch (e) {
      setProblem(problemOf(e));
    }
  };

  const addPrefix = (i: number) => {
    const p = normalisePrefix(typed[i] ?? "");
    const z = zones[i];
    if (!p || !country || !z) return;
    if (!z.postal.some((x) => x.prefix === p && x.country === country))
      set(i, { postal: [...z.postal, { country, prefix: p }] });
    setTyped({ ...typed, [i]: "" });
  };

  const detail = typeof problem === "string" ? problem : problem?.detail;
  return (
    <section className="card glass stack">
      <SectionHead title="Delivery zones" />
      <p className="lede small">
        Inside out: an address goes in the first zone it falls in. Where you deliver from stays private.
      </p>
      {zones.some((z) => z.mode === "radius") && !measured && (
        <p className="hint">
          A distance is measured from your premises: set where you are in <Link to="/settings/area">Area</Link>.
        </p>
      )}
      {zones.length === 0 && <p className="hint">No zones yet: delivery is not offered until you add one.</p>}
      {zones.map((z, i) => (
        <div key={z.key} className="zone stack">
          <div className="option-head">
            <input
              className="input"
              aria-label="Zone name"
              placeholder={i === 0 ? "Nearby" : "Further out"}
              value={z.name}
              maxLength={60}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={`Remove ${z.name || "this zone"}`}
              onClick={() => setZones(zones.filter((_, j) => j !== i))}
            >
              <X className="icon-sm" aria-hidden="true" />
            </button>
          </div>
          <fieldset className="seg">
            <legend className="sr-only">Measured by</legend>
            <button type="button" aria-pressed={z.mode === "radius"} onClick={() => set(i, { mode: "radius" })}>
              Distance
            </button>
            <button type="button" aria-pressed={z.mode === "postal"} onClick={() => set(i, { mode: "postal" })}>
              Postal codes
            </button>
          </fieldset>
          {z.mode === "radius" ? (
            <div className="chips">
              {RING_CHIPS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="chip"
                  aria-pressed={z.radiusKm === r}
                  onClick={() => set(i, { radiusKm: r })}
                >
                  {r} km
                </button>
              ))}
            </div>
          ) : (
            <div className="stack">
              <div className="inline-add">
                <input
                  className="input"
                  aria-label="Postal code, or its start"
                  autoComplete="off"
                  value={typed[i] ?? ""}
                  onChange={(e) => setTyped({ ...typed, [i]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPrefix(i);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!(typed[i] ?? "").trim()}
                  onClick={() => addPrefix(i)}
                >
                  Add
                </button>
              </div>
              {z.postal.length > 0 && (
                <ul className="chips" aria-label="Postal codes in this zone">
                  {z.postal.map((p) => (
                    <li key={`${p.country}:${p.prefix}`} className="chip chip-removable">
                      <span>{p.prefix}</span>
                      <button
                        type="button"
                        className="chip-x"
                        aria-label={`Remove ${p.prefix}`}
                        onClick={() => set(i, { postal: z.postal.filter((x) => x !== p) })}
                      >
                        <X className="icon-xs" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="grid2">
            <div>
              <label className="label" htmlFor={`fee-${i}`}>
                Delivery fee
              </label>
              <MoneyInput
                id={`fee-${i}`}
                value={z.fee}
                currency={currency}
                placeholder="Free"
                onChange={(v) => set(i, { fee: v })}
              />
            </div>
            <div>
              <label className="label" htmlFor={`min-${i}`}>
                Minimum order
              </label>
              <MoneyInput
                id={`min-${i}`}
                value={z.minimum}
                currency={currency}
                placeholder="None"
                onChange={(v) => set(i, { minimum: v })}
              />
            </div>
          </div>
          <fieldset className="chips-field">
            <legend className="label">On the road for</legend>
            <div className="chips">
              {ETA_CHIPS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className="chip"
                  aria-pressed={z.etaMin === m}
                  onClick={() => set(i, { etaMin: z.etaMin === m ? null : m })}
                >
                  {m} min
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      ))}
      {zones.length < 10 && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() =>
            setZones([
              ...zones,
              {
                key: Math.max(0, ...zones.map((x) => x.key)) + 1,
                name: "",
                mode: "radius",
                radiusKm: zones.length ? 5 : 2,
                postal: [],
                fee: "",
                minimum: "",
                etaMin: 30,
              },
            ])
          }
        >
          <Plus className="icon-xs" aria-hidden="true" /> A zone
        </button>
      )}
      {detail && <Toast tone="danger" text={detail} onDismiss={() => setProblem(null)} />}
      {typeof problem !== "string" && problem?.code === "version_conflict" && (
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
          {save.isPending ? "Saving…" : "Save zones"}
        </button>
      </FormActions>
    </section>
  );
}

/** Tables: a service booked by covers, the largest party, a price asked above a size, a deposit, covers set aside. */
function Tables() {
  const services = useServices();
  const settings = useSettings();
  const currency = settings.data?.doc.business.currency ?? "EUR";
  const rows = (services.data?.items ?? []).filter((s) => s.active);
  if (rows.length === 0) return null;
  return (
    <section className="card glass stack">
      <SectionHead title="Tables" />
      <p className="lede small">
        A service booked by covers: a sitting holds as many people as you set aside for it here. Above that, or for a
        large party, the request comes to you.
      </p>
      <div className="rows">
        {rows.map((s) => (
          <TableRow key={s.id} service={s} currency={currency} />
        ))}
      </div>
    </section>
  );
}

type TableService = ServiceRow & { capacityUnit?: string; tableRules?: unknown };

function draftOf(s: TableService, currency: string): TablesDraft {
  // Stored as JSON text; the API may hand it back read already.
  let rules: Record<string, unknown> = {};
  try {
    const raw = typeof s.tableRules === "string" ? (JSON.parse(s.tableRules) as unknown) : s.tableRules;
    rules = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    rules = {};
  }
  const dep = rules.deposit as { perPerson: Money; fromParty: number } | undefined;
  return {
    on: s.capacityUnit === "people",
    maxParty: typeof rules.maxParty === "number" ? rules.maxParty : 8,
    quoteAbove: typeof rules.quoteAbove === "number" ? rules.quoteAbove : null,
    setAside: typeof rules.setAside === "number" ? rules.setAside : null,
    deposit: dep ? { perPerson: majorText(dep.perPerson.value, currency), fromParty: dep.fromParty } : null,
  };
}

function TableRow({ service, currency }: { service: ServiceRow; currency: string }) {
  const qc = useQueryClient();
  const [d, setD] = useState<TablesDraft>(draftOf(service as TableService, currency));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const submit = async () => {
    setProblem(null);
    setSaved(false);
    const w = tablesWrite(d, currency);
    if (w && "problem" in w) {
      setProblem(String(w.problem));
      return;
    }
    setBusy(true);
    try {
      await foodApi.tables(service.id, w);
      void qc.invalidateQueries({ queryKey: qk.services });
      setSaved(true);
    } catch (e) {
      setProblem(problemOf(e).detail);
    } finally {
      setBusy(false);
    }
  };
  const summary = d.on
    ? [
        `Up to ${d.maxParty} people`,
        d.setAside ? `${d.setAside} covers set aside` : "you confirm each",
        d.deposit
          ? `${formatMoney(parseMoney(d.deposit.perPerson, currency))} a person from ${d.deposit.fromParty}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Counted in bookings";
  return (
    <div className="catalogue-row row-glass">
      <div className="catalogue-main">
        <div className="t">
          <b>{service.name}</b>
        </div>
        <div className="s">{summary}</div>
      </div>
      <div className="rowx">
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Close" : "Tables"}
        </button>
      </div>
      {open && (
        <div className="wide stack table-rules">
          <Switch checked={d.on} onChange={(v) => setD({ ...d, on: v })}>
            Book this by covers
          </Switch>
          {d.on && (
            <>
              <div className="grid2">
                <Stepper
                  id={`max-${service.id}`}
                  label="The largest party"
                  value={String(d.maxParty)}
                  onChange={(v) => setD({ ...d, maxParty: Math.max(1, Number(v) || 1) })}
                  min={1}
                  max={200}
                  suffix="people"
                />
                <div className="stack">
                  <Switch
                    checked={d.setAside !== null}
                    onChange={(v) => setD({ ...d, setAside: v ? Math.max(d.maxParty, 20) : null })}
                  >
                    Covers set aside for here
                  </Switch>
                  {d.setAside !== null && (
                    <Stepper
                      id={`aside-${service.id}`}
                      label="Covers a sitting"
                      value={String(d.setAside)}
                      onChange={(v) => setD({ ...d, setAside: Math.max(1, Number(v) || 1) })}
                      min={1}
                      max={1000}
                      hint="Bookings inside them confirm at once; without, you confirm each."
                    />
                  )}
                </div>
              </div>
              <div className="grid2">
                <div className="stack">
                  <Switch
                    checked={d.quoteAbove !== null}
                    onChange={(v) => setD({ ...d, quoteAbove: v ? Math.min(10, d.maxParty) : null })}
                  >
                    A large party asks for a price
                  </Switch>
                  {d.quoteAbove !== null && (
                    <Stepper
                      id={`quote-${service.id}`}
                      label="Above"
                      value={String(d.quoteAbove)}
                      onChange={(v) => setD({ ...d, quoteAbove: Math.max(1, Number(v) || 1) })}
                      min={1}
                      max={d.maxParty}
                      suffix="people"
                    />
                  )}
                </div>
                <div className="stack">
                  <Switch
                    checked={d.deposit !== null}
                    onChange={(v) => setD({ ...d, deposit: v ? { perPerson: "", fromParty: 6 } : null })}
                  >
                    A deposit per person
                  </Switch>
                  {d.deposit && (
                    <>
                      <MoneyInput
                        id={`dep-${service.id}`}
                        value={d.deposit.perPerson}
                        currency={currency}
                        onChange={(v) => setD({ ...d, deposit: d.deposit && { ...d.deposit, perPerson: v } })}
                      />
                      <Stepper
                        id={`from-${service.id}`}
                        label="From a party of"
                        value={String(d.deposit.fromParty)}
                        onChange={(v) =>
                          setD({ ...d, deposit: d.deposit && { ...d.deposit, fromParty: Math.max(1, Number(v) || 1) } })
                        }
                        min={1}
                        max={200}
                      />
                    </>
                  )}
                </div>
              </div>
            </>
          )}
          {problem && <p className="hint error">{problem}</p>}
          <FormActions>
            {saved && (
              <span className="hint" role="status">
                Saved
              </span>
            )}
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </FormActions>
        </div>
      )}
    </div>
  );
}
