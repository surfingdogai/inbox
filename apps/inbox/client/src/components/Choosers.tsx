import clsx from "clsx";
import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { countryOptions } from "../lib/countries";
import { currencyGroups, currencyLabel, currencySymbol, symbolAfter } from "../lib/currencies";
import { languageName, matchLanguages, nativeName } from "../lib/languages";
import { browserZone, placeOf, zoneGroups } from "../lib/zones";

/**
 * The choosers every Settings form uses, so nobody types a code or guesses a format: a time zone by
 * place, a currency by name, languages by name, a country by name, an amount with its currency, a
 * length from the usual ones. Native controls wherever one fits, so they work with a keyboard and on
 * a phone as the platform's own do.
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

/** A time zone, by place, grouped by region, each with the time it is there now; and the browser's, one click away. */
export function TimeZoneSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean | undefined;
}) {
  const now = useMinute();
  const groups = useMemo(() => zoneGroups(now, [value]), [now, value]);
  const browser = browserZone();
  return (
    <>
      <select id={id} className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {groups.map((g) => (
          <optgroup key={g.region} label={g.region}>
            {g.zones.map((z) => (
              <option key={z.zone} value={z.zone}>
                {z.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {browser && browser !== value && !disabled && (
        <button type="button" className="linkish" onClick={() => onChange(browser)}>
          Use {placeOf(browser)}, where you are
        </button>
      )}
    </>
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

/** A country by name; empty is none. */
export function CountrySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (code: string) => void;
}) {
  const options = useMemo(() => countryOptions(value), [value]);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not set</option>
      {options.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
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
              min={5}
              max={1440}
              step={5}
              aria-label="Minutes"
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

/**
 * Languages by name: chips for the chosen ones (× takes one off), and a field that offers the rest as
 * the owner types, the common ones first. Arrow keys move through what is offered, Enter adds,
 * Backspace in the empty field takes the last chip off, Escape closes the list.
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
