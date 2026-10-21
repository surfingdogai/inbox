import { LocateFixed, X } from "lucide-react";
import { useState } from "react";
import { countryName } from "../lib/countries";
import { type AreaDraft, normalisePrefix, type PostalShape, WIZARD_RADII } from "../lib/trades";
import { CountrySelect } from "./Choosers";
import "../trades.css";

/**
 * Where a trade works, as the setup asks it (ADR-034 §3): postal codes, or a distance from where this
 * device is now; or skipped, and the inbox says it works anywhere. Settings → Area has the rest (the
 * premises, a request from outside). The place a distance is measured from is never shown to anyone.
 */

export function WhereYouWork({
  value,
  onChange,
  shapes,
}: {
  value: AreaDraft;
  onChange: (next: AreaDraft) => void;
  shapes: Readonly<Record<string, PostalShape>> | undefined;
}) {
  const [prefix, setPrefix] = useState("");
  const [locating, setLocating] = useState(false);
  const [located, setLocated] = useState<string | null>(null);
  const shape = shapes?.[value.country];
  const matched = !shapes || shape !== undefined;
  const add = () => {
    const p = normalisePrefix(prefix);
    if (!p || !value.country || !matched) return;
    if (!value.postal.some((x) => x.country === value.country && x.prefix === p)) {
      onChange({ ...value, postal: [...value.postal, { country: value.country, prefix: p }] });
    }
    setPrefix("");
  };
  const here = () => {
    if (!("geolocation" in navigator)) {
      setLocated("This device cannot say where it is. Use postal codes instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLocated(null);
        const point = {
          lat: Math.round(pos.coords.latitude * 1000) / 1000,
          lng: Math.round(pos.coords.longitude * 1000) / 1000,
        };
        const label = `Where I was on ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
        onChange({ ...value, base: { from: "device", point, label } });
      },
      () => {
        setLocating(false);
        setLocated("This device did not say where it is. Allow location for this page, or use postal codes.");
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
    );
  };
  return (
    <div className="stack area">
      <fieldset className="seg">
        <legend className="sr-only">How you say where you work</legend>
        <button
          type="button"
          aria-pressed={value.mode === "postal"}
          onClick={() => onChange({ ...value, mode: "postal" })}
        >
          Postal codes
        </button>
        <button
          type="button"
          aria-pressed={value.mode === "radius"}
          onClick={() => onChange({ ...value, mode: "radius" })}
        >
          Distance
        </button>
      </fieldset>

      {value.mode === "postal" && (
        <div className="stack">
          <div className="grid2">
            <div>
              <label className="label" htmlFor="su-area-country">
                Country
              </label>
              <CountrySelect
                id="su-area-country"
                value={value.country}
                onChange={(country) => onChange({ ...value, country })}
              />
            </div>
            <div>
              <label className="label" htmlFor="su-area-prefix">
                Postal code, or its start
              </label>
              <div className="inline-add">
                <input
                  id="su-area-prefix"
                  className="input"
                  autoComplete="off"
                  value={prefix}
                  placeholder={shape?.example ?? ""}
                  disabled={!matched}
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
                  disabled={!prefix.trim() || !matched}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
          {value.postal.length > 0 ? (
            <ul className="chips" aria-label="Postal codes you cover">
              {value.postal.map((p) => (
                <li key={`${p.country}:${p.prefix}`} className="chip chip-removable">
                  <span>
                    {p.prefix} <span className="hint">· {countryName(p.country)}</span>
                  </span>
                  <button
                    type="button"
                    className="chip-x"
                    aria-label={`Remove ${p.prefix}`}
                    onClick={() => onChange({ ...value, postal: value.postal.filter((x) => x !== p) })}
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
          {!matched && (
            <p className="hint">Postal codes can't be matched in {countryName(value.country)} yet: use a distance.</p>
          )}
        </div>
      )}

      {value.mode === "radius" && (
        <div className="stack">
          <div className="chips">
            <button
              type="button"
              className="chip"
              aria-pressed={value.base !== null}
              onClick={here}
              disabled={locating}
            >
              <LocateFixed className="icon-sm" aria-hidden="true" />
              {locating ? "Finding…" : value.base ? value.base.label : "Where I am now"}
            </button>
          </div>
          {located && <p className="hint error">{located}</p>}
          <div className="chips">
            {WIZARD_RADII.map((km) => (
              <button
                key={km}
                type="button"
                className="chip"
                aria-pressed={value.radiusKm === km}
                onClick={() => onChange({ ...value, radiusKm: km })}
              >
                {km} km
              </button>
            ))}
          </div>
          <p className="hint">
            Checked only when an agent sends the site's location. Otherwise the request comes to you to decide.
          </p>
        </div>
      )}
    </div>
  );
}
