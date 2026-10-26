import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LocateFixed, MapPin, X } from "lucide-react";
import { useState } from "react";
import { CountrySelect, Stepper } from "../components/Choosers";
import { ErrorState, Toast } from "../components/Feedback";
import { FormActions, SectionHead } from "../components/Form";
import { type ApiProblem, problemOf } from "../lib/api";
import { countryName } from "../lib/countries";
import { countryOfZone } from "../lib/geo";
import { qk, useSaveSettings, useSettings } from "../lib/queries";
import { type AreaDoc, areaSentence, normalisePrefix, RADIUS_CHIPS, useWork } from "../lib/trades";
import type { SettingsDoc } from "../lib/types";
import "../trades.css";

export const Route = createFileRoute("/settings/area")({
  component: AreaPage,
});

/**
 * Settings → Area (ADR-039 §3): where the business works. Postal codes, or a distance from a place it
 * chooses — its premises as Settings → General has them, or where this device is now — or anywhere;
 * and what a request from outside gets. The place a radius is measured from is never shown to anyone:
 * agents are told the radius, or the postal codes, and a request's site as a band.
 */
function AreaPage() {
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
  return <AreaForm key={round} data={settings.data} onReload={reload} />;
}

type Mode = AreaDoc["mode"];

function AreaForm({ data, onReload }: { data: SettingsDoc; onReload: () => void }) {
  const save = useSaveSettings();
  const work = useWork();
  const qc = useQueryClient();
  const doc = data.doc as SettingsDoc["doc"] & { area: AreaDoc };
  const area = doc.area;
  const premises = doc.directory.geo;
  const home = doc.directory.address.addressCountry || countryOfZone(doc.business.timezone) || "";
  const [mode, setMode] = useState<Mode>(area.mode);
  const [radius, setRadius] = useState(String(area.radiusKm));
  const [base, setBase] = useState<AreaDoc["base"]>(area.base ?? (premises ? { from: "business" } : null));
  const [postal, setPostal] = useState<readonly { country: string; prefix: string }[]>(area.postal);
  const [country, setCountry] = useState(home);
  const [prefix, setPrefix] = useState("");
  const [outside, setOutside] = useState<AreaDoc["outside"]>(area.outside);
  const [locating, setLocating] = useState(false);
  const [located, setLocated] = useState<string | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [saved, setSaved] = useState(false);

  const custom = !RADIUS_CHIPS.some((r) => String(r) === radius);
  // How the chosen country's codes are written; none: they cannot be matched there yet.
  const shape = work.data?.postal?.[country];
  const matched = !work.data?.postal || shape !== undefined;
  const [pendingError, setPendingError] = useState<string | null>(null);
  /** The list with what is typed added: what Add does, and what Save does first. */
  const withTyped = (): readonly { country: string; prefix: string }[] => {
    const p = normalisePrefix(prefix);
    if (!p || !country || !matched) return postal;
    return postal.some((x) => x.country === country && x.prefix === p) ? postal : [...postal, { country, prefix: p }];
  };
  const add = () => {
    setPostal(withTyped());
    setPrefix("");
    setPendingError(null);
  };
  const here = () => {
    if (!("geolocation" in navigator)) {
      setLocated("This device cannot say where it is.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        // About 100 m is all a radius needs; the server rounds it the same way.
        const point = {
          lat: Math.round(pos.coords.latitude * 1000) / 1000,
          lng: Math.round(pos.coords.longitude * 1000) / 1000,
        };
        const label = `Where I was on ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
        setBase({ from: "device", point, label });
        setLocated(null);
      },
      () => {
        setLocating(false);
        setLocated("This device did not say where it is. Allow location for this page, or use your premises.");
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
    );
  };
  const submit = async () => {
    setProblem(null);
    setSaved(false);
    // A code typed and not added is added, never dropped; postal codes and none of them is not saved.
    const codes = withTyped();
    if (codes !== postal) {
      setPostal(codes);
      setPrefix("");
    }
    if (mode === "postal" && codes.length === 0) {
      setPendingError("Add at least one postal code, or choose Anywhere.");
      return;
    }
    setPendingError(null);
    try {
      await save.mutateAsync({
        doc: {
          area: {
            mode,
            radiusKm: Math.max(1, Math.min(1000, Number(radius) || 25)),
            base: mode === "radius" ? base : (area.base ?? null),
            postal: [...codes],
            outside,
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
  const fieldError =
    pendingError ?? problem?.field("area.postal") ?? problem?.field("postal") ?? problem?.field("area.mode");

  return (
    <section className="card glass stack area">
      <SectionHead title="Where you work" />
      <p className="lede small">
        Agents check a site against this before they ask. Where you set out from stays private.
      </p>
      <fieldset className="seg">
        <legend className="sr-only">How you say where you work</legend>
        {(
          [
            ["postal", "Postal codes"],
            ["radius", "Distance"],
            ["anywhere", "Anywhere"],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </fieldset>

      {mode === "radius" && (
        <div className="stack area-radius">
          <fieldset className="chips-field">
            <legend className="label">From</legend>
            <div className="chips">
              {premises && (
                <button
                  type="button"
                  className="chip"
                  aria-pressed={base?.from === "business"}
                  onClick={() => setBase({ from: "business" })}
                >
                  <MapPin className="icon-sm" aria-hidden="true" />
                  Your premises
                </button>
              )}
              <button
                type="button"
                className="chip"
                aria-pressed={base?.from === "device"}
                onClick={here}
                disabled={locating}
              >
                <LocateFixed className="icon-sm" aria-hidden="true" />
                {locating ? "Finding…" : base?.from === "device" ? (base.label ?? "Where I was") : "Where I am now"}
              </button>
            </div>
            {!premises && !base && (
              <p className="hint">At your premises now? Press Where I am now. Or use postal codes.</p>
            )}
            {located && <p className="hint error">{located}</p>}
            {!base && (
              <p className="hint">Without a place, agents are told your distance and you decide on each request.</p>
            )}
          </fieldset>
          <fieldset className="chips-field">
            <legend className="label">How far</legend>
            <div className="chips">
              {RADIUS_CHIPS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="chip"
                  aria-pressed={radius === String(r)}
                  onClick={() => setRadius(String(r))}
                >
                  {r} km
                </button>
              ))}
              <button
                type="button"
                className="chip"
                aria-pressed={custom}
                onClick={() => setRadius(custom ? radius : "15")}
              >
                Other
              </button>
            </div>
          </fieldset>
          {custom && (
            <Stepper
              id="area-radius"
              label="Kilometres"
              value={radius}
              onChange={setRadius}
              min={1}
              max={1000}
              suffix="km"
            />
          )}
          <p className="hint">
            Checked only when an agent sends the site's location. Otherwise the request comes to you to decide.
          </p>
        </div>
      )}

      {mode === "postal" && (
        <div className="stack area-postal">
          <div className="grid2">
            <div>
              <label className="label" htmlFor="area-country">
                Country
              </label>
              <CountrySelect id="area-country" value={country} onChange={setCountry} suggest={home || null} />
            </div>
            <div>
              <label className="label" htmlFor="area-prefix">
                Postal code, or its start
              </label>
              <div className="inline-add">
                <input
                  id="area-prefix"
                  className="input"
                  autoComplete="off"
                  value={prefix}
                  placeholder={shape?.example ?? ""}
                  disabled={!matched}
                  aria-invalid={fieldError ? true : undefined}
                  onChange={(e) => setPrefix(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={add}
                  disabled={!prefix.trim() || !country || !matched}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
          {postal.length > 0 ? (
            <ul className="chips" aria-label="Postal codes you cover">
              {postal.map((p) => (
                <li key={`${p.country}:${p.prefix}`} className="chip chip-removable">
                  <span>
                    {p.prefix} <span className="hint">· {countryName(p.country)}</span>
                  </span>
                  <button
                    type="button"
                    className="chip-x"
                    aria-label={`Remove ${p.prefix}`}
                    onClick={() => setPostal(postal.filter((x) => x !== p))}
                  >
                    <X className="icon-xs" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : matched && shape ? (
            <p className="hint">
              The start of a code covers every code under it: {shape.example} covers {shape.covers}.
            </p>
          ) : null}
          {!matched && country && (
            <p className="hint">Postal codes can't be matched in {countryName(country)} yet: use a distance.</p>
          )}
          {fieldError && <p className="hint error">{fieldError}</p>}
        </div>
      )}

      {mode !== "anywhere" && (
        <fieldset className="chips-field">
          <legend className="label">A request from outside</legend>
          <fieldset className="seg">
            <legend className="sr-only">A request from outside</legend>
            <button type="button" aria-pressed={outside === "on_request"} onClick={() => setOutside("on_request")}>
              I decide
            </button>
            <button type="button" aria-pressed={outside === "decline"} onClick={() => setOutside("decline")}>
              Decline it
            </button>
          </fieldset>
        </fieldset>
      )}

      {work.data && <p className="hint area-public">{areaSentence(work.data.public.area)}</p>}
      {problem && !fieldError && <Toast tone="danger" text={problem.detail} onDismiss={() => setProblem(null)} />}
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
