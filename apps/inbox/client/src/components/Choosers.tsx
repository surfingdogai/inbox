import clsx from "clsx";
import { Minus, Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { countryName, countryOptions } from "../lib/countries";
import { currencyGroups, currencyLabel, currencySymbol, symbolAfter } from "../lib/currencies";
import {
  bestUnit,
  type DurationPreset,
  type DurationUnit,
  durationWords,
  fromMinutes,
  inMinutes,
  isPreset,
} from "../lib/durations";
import { languageName, matchLanguages, nativeName } from "../lib/languages";
import { browserZone, matchZones, type ZoneChoice, zoneChoice, zoneChoices } from "../lib/zones";

/**
 * The choosers every Settings form uses, so nobody types a code or guesses a format: a time zone by
 * country and city, a currency by name, languages by name, a country by name, an amount with its
 * currency, a length of time from the usual ones, a small number with − and +. Native controls
 * wherever one fits, so they work with a keyboard and on a phone as the platform's own do.
 */

/** The clock, ticking once a minute while a chooser that shows times is on screen. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return Math.floor(now / 60_000) * 60_000;
}

/**
 * A time zone, typed ahead by country or city (`Portugal — Lisbon · 14:05`). Opened, it suggests the
 * zone this browser is in and the business's country's own first. Arrow keys move, Enter picks,
 * Escape leaves the choice as it was.
 */
export function TimeZonePicker({
  id,
  value,
  onChange,
  country,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  /** The business's country, whose zones are suggested first. */
  country?: string | null | undefined;
  describedBy?: string | undefined;
}) {
  const now = useMinute();
  const browser = browserZone();
  const { suggested, all } = useMemo(
    () => zoneChoices(now, { keep: value, browser, country: country ?? null }),
    [now, value, browser, country],
  );
  const current = all.find((c) => c.zone === value) ?? zoneChoice(value, now);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = `${id}-list`;
  const typed = text.trim() !== "";
  const options: readonly ZoneChoice[] = open ? (typed ? matchZones(text, all) : suggested) : [];
  const pick = (zone: string) => {
    onChange(zone);
    setText("");
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      const choice = options[active];
      if (open && choice) {
        e.preventDefault();
        pick(choice.zone);
      }
    } else if (e.key === "Escape") {
      setText("");
      setOpen(false);
    }
  };
  return (
    <div className="combo">
      <input
        ref={input}
        id={id}
        className="input combo-field"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={describedBy}
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={open ? "Type a city or a country" : undefined}
        value={open ? text : `${current.name}${current.clock ? ` · ${current.clock}` : ""}`}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={(e) => {
          setOpen(true);
          setActive(0);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setOpen(false);
          setText("");
        }}
        onKeyDown={onKey}
      />
      {open && (
        <div id={listId} className="combo-list glass-strong" role="listbox" aria-label="Time zones">
          {!typed && options.length > 0 && <div className="combo-head">Suggested</div>}
          {options.map((c, i) => (
            <div
              key={c.zone}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={clsx("combo-option", i === active && "is-active", c.zone === value && "is-current")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c.zone);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="combo-name">
                {c.name}
                {c.zone === browser && <span className="combo-note">where you are</span>}
              </span>
              <span className="combo-clock">{c.clock}</span>
            </div>
          ))}
          {typed && options.length === 0 && <div className="combo-empty">No place by that name.</div>}
          {!typed && <div className="combo-empty">Type a city or a country for any other.</div>}
        </div>
      )}
    </div>
  );
}

/** A currency by name: the common ones first, `€ EUR — Euro`. */
export function CurrencySelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean | undefined;
}) {
  const groups = useMemo(() => currencyGroups(value), [value]);
  return (
    <select id={id} className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <optgroup label="Common">
        {groups.common.map((c) => (
          <option key={c} value={c}>
            {currencyLabel(c)}
          </option>
        ))}
      </optgroup>
      <optgroup label="All currencies">
        {groups.all.map((c) => (
          <option key={c} value={c}>
            {currencyLabel(c)}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/** A country by name; empty is none. `suggest` is offered one press away while none is chosen. */
export function CountrySelect({
  id,
  value,
  onChange,
  suggest,
}: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  suggest?: string | null | undefined;
}) {
  const options = useMemo(() => countryOptions(value), [value]);
  return (
    <>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not set</option>
        {options.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
      {!value && suggest && (
        <button type="button" className="linkish" onClick={() => onChange(suggest)}>
          Use {countryName(suggest)}
        </button>
      )}
    </>
  );
}

/** An amount, with the business's currency in the field, where this browser writes it. */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  placeholder,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (typed: string) => void;
  currency: string;
  placeholder?: string | undefined;
  invalid?: boolean | undefined;
}) {
  const symbol = currencySymbol(currency);
  const after = symbolAfter(currency);
  return (
    <div className={clsx("money-input", after && "is-after")}>
      <span className="money-sym" aria-hidden="true">
        {symbol}
      </span>
      <input
        id={id}
        className="input"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-cur`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={`${id}-cur`} className="sr-only">
        in {currency}
      </span>
    </div>
  );
}

/** The usual lengths, one press each; Other opens a field for anything else. */
const LENGTHS: readonly { readonly min: number; readonly label: string }[] = [
  { min: 15, label: "15 min" },
  { min: 30, label: "30 min" },
  { min: 45, label: "45 min" },
  { min: 60, label: "1 h" },
  { min: 90, label: "1 h 30" },
  { min: 120, label: "2 h" },
];

/** Whether `minutes` is one of the usual lengths. */
export function usualLength(minutes: string): boolean {
  return LENGTHS.some((l) => String(l.min) === minutes.trim());
}

export function LengthPicker({
  legend,
  value,
  onChange,
  error,
}: {
  legend: string;
  value: string;
  onChange: (minutes: string) => void;
  error?: string | undefined;
}) {
  const name = useId();
  const [other, setOther] = useState(() => !usualLength(value));
  return (
    <fieldset className="chips-field">
      <legend className="label">{legend}</legend>
      <div className="chips" role="radiogroup">
        {LENGTHS.map((l) => (
          <label key={l.min} className="chip">
            <input
              type="radio"
              name={name}
              checked={!other && value === String(l.min)}
              onChange={() => {
                setOther(false);
                onChange(String(l.min));
              }}
            />
            <span>{l.label}</span>
          </label>
        ))}
        <label className="chip">
          <input type="radio" name={name} checked={other} onChange={() => setOther(true)} />
          <span>Other</span>
        </label>
        {other && (
          <span className="chip-other">
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={5}
              max={1440}
              step={5}
              aria-label={`${legend}, minutes`}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            <span className="hint">min</span>
          </span>
        )}
      </div>
      {error && (
        <div className="hint error" role="alert">
          {error}
        </div>
      )}
    </fieldset>
  );
}

const UNIT_WORDS: Readonly<Record<DurationUnit, string>> = { min: "minutes", h: "hours", days: "days" };
const COARSER: Readonly<Record<DurationUnit, readonly DurationUnit[]>> = {
  min: ["min", "h", "days"],
  h: ["h", "days"],
  days: ["days"],
};

/**
 * A length of time from the usual ones, one press each, said back in words ("24 hours"). Other opens
 * a number with its unit (minutes, hours or days, as fine as the setting keeps). The value stays in
 * the setting's own unit (`unit`); an optional one may be empty, which its first preset names.
 */
export function DurationPicker({
  id,
  legend,
  value,
  onChange,
  unit,
  presets,
  min = 0,
  max,
  hint,
  error,
}: {
  id: string;
  legend: string;
  /** In `unit`, as typed; "" for none set, when a preset says what that means. */
  value: string;
  onChange: (value: string) => void;
  unit: DurationUnit;
  presets: readonly DurationPreset[];
  /** Bounds in `unit`. */
  min?: number | undefined;
  max?: number | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}) {
  const name = useId();
  const [other, setOther] = useState(() => !isPreset(value, presets));
  const stored = value.trim() === "" ? null : Number(value);
  const minutes = stored === null || !Number.isFinite(stored) ? null : inMinutes(stored, unit);
  const units = COARSER[unit];
  const [otherUnit, setOtherUnit] = useState<DurationUnit>(() => bestUnit(minutes ?? 0, units));
  const shown = minutes === null ? "" : String(Math.round((minutes / inMinutes(1, otherUnit)) * 100) / 100);
  const none = presets.find((p) => p.value === null)?.label;
  const words =
    minutes === null ? (none ?? "") : Number.isFinite(minutes) ? durationWords(minutes, none ?? "None") : "";
  const hintId = `${id}-hint`;
  return (
    <fieldset className="chips-field" aria-describedby={hint || error ? hintId : undefined}>
      <legend className="label label-line">
        <span>{legend}</span>
        {words && !error && <span className="dur-words">{words}</span>}
      </legend>
      <div className="chips" role="radiogroup">
        {presets.map((p) => (
          <label key={p.label} className="chip">
            <input
              type="radio"
              name={name}
              checked={!other && (p.value === null ? stored === null : stored === p.value)}
              onChange={() => {
                setOther(false);
                onChange(p.value === null ? "" : String(p.value));
              }}
            />
            <span>{p.label}</span>
          </label>
        ))}
        <label className="chip">
          <input
            type="radio"
            name={name}
            checked={other}
            onChange={() => {
              setOther(true);
              setOtherUnit(bestUnit(minutes ?? 0, units));
            }}
          />
          <span>Other</span>
        </label>
        {other && (
          <span className="chip-other">
            <input
              id={id}
              className="input"
              type="number"
              inputMode="numeric"
              min={Math.ceil(fromMinutes(inMinutes(min, unit), otherUnit))}
              max={max === undefined ? undefined : Math.floor(inMinutes(max, unit) / inMinutes(1, otherUnit))}
              step={1}
              aria-label={`${legend}, in ${UNIT_WORDS[otherUnit]}`}
              value={shown}
              onChange={(e) => {
                const typed = e.target.value.trim();
                if (typed === "") return onChange("");
                const n = Number(typed);
                // Kept as typed when it is not a number, so the API names the field.
                onChange(Number.isFinite(n) ? String(fromMinutes(inMinutes(n, otherUnit), unit)) : typed);
              }}
            />
            {units.length > 1 ? (
              <select
                className="input unit-select"
                aria-label={`${legend}, unit`}
                value={otherUnit}
                onChange={(e) => setOtherUnit(e.target.value as DurationUnit)}
              >
                {units.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_WORDS[u]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="hint">{UNIT_WORDS[unit]}</span>
            )}
          </span>
        )}
      </div>
      {error ? (
        <div id={hintId} className="hint error" role="alert">
          {error}
        </div>
      ) : (
        hint && (
          <div id={hintId} className="hint">
            {hint}
          </div>
        )
      )}
    </fieldset>
  );
}

/** A small whole number, with − and + either side; typing works too. */
export function Stepper({
  id,
  label,
  value,
  onChange,
  min,
  max,
  suffix,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  /** After the number: "%", "per customer". */
  suffix?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}) {
  const n = Number(value);
  const at = Number.isFinite(n) ? n : min;
  const step = (d: number) => onChange(String(Math.min(max, Math.max(min, Math.round(at) + d))));
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="stepper">
        <button
          type="button"
          className="btn btn-ghost btn-icon stepper-btn"
          aria-label={`One less: ${label}`}
          disabled={at <= min}
          onClick={() => step(-1)}
        >
          <Minus className="icon-sm" aria-hidden="true" />
        </button>
        <input
          id={id}
          className="input stepper-field"
          inputMode="numeric"
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
        />
        <button
          type="button"
          className="btn btn-ghost btn-icon stepper-btn"
          aria-label={`One more: ${label}`}
          disabled={at >= max}
          onClick={() => step(1)}
        >
          <Plus className="icon-sm" aria-hidden="true" />
        </button>
        {suffix && <span className="hint stepper-suffix">{suffix}</span>}
      </div>
      {error ? (
        <div className="hint error" role="alert">
          {error}
        </div>
      ) : (
        hint && <div className="hint">{hint}</div>
      )}
    </div>
  );
}

/**
 * Languages by name: chips for the chosen ones (× takes one off), and a field that offers the rest as
 * the owner types, the common ones first; each named in English with its own name beside it, greyed.
 * Arrow keys move through what is offered, Enter adds, Backspace in the empty field takes the last
 * chip off, Escape closes the list.
 */
export function LanguagePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: readonly string[];
  onChange: (codes: readonly string[]) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = `${id}-list`;
  const matches = useMemo(() => (open ? matchLanguages(text, value) : []), [open, text, value]);
  const add = (code: string) => {
    onChange([...value, code]);
    setText("");
    setActive(0);
    input.current?.focus();
  };
  const remove = (code: string) => onChange(value.filter((c) => c !== code));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      const pick = matches[active];
      if (open && pick) {
        e.preventDefault();
        add(pick);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      remove(value[value.length - 1] as string);
    }
  };
  return (
    <div className="lang-picker">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the box's free space focuses its field */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the field inside takes the keys */}
      <div className="input lang-box" onClick={() => input.current?.focus()}>
        {value.map((code) => (
          <span key={code} className="lang-chip">
            {languageName(code)}
            <button
              type="button"
              className="lang-x"
              aria-label={`Remove ${languageName(code)}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(code);
              }}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          className="lang-field"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${matches[active]}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={value.length ? "Add another" : "Add a language"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
        />
      </div>
      {open && matches.length > 0 && (
        <div id={listId} className="lang-list glass-strong" role="listbox" aria-label="Languages">
          {matches.map((code, i) => (
            <div
              key={code}
              id={`${listId}-${code}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={clsx("lang-option", i === active && "is-active")}
              onMouseDown={(e) => {
                e.preventDefault();
                add(code);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {languageName(code)}
              {nativeName(code) && <span className="lang-native">{nativeName(code)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Where a detail was read, for the owner to check: `Read from salon.example · please check` when only
 * a page's words said it, `From salon.example` when the site declared it. Gone once the owner saves.
 */
export function SourceTag({ source }: { source: { readonly host: string; readonly check: boolean } | null }) {
  if (!source) return null;
  return (
    <span className={clsx("source-tag", source.check && "is-check")}>
      {source.check ? `Read from ${source.host} · please check` : `From ${source.host}`}
    </span>
  );
}
