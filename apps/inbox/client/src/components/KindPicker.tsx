import clsx from "clsx";
import { type KeyboardEvent, useMemo, useState } from "react";
import { type BusinessKind, kindAlso, matchKinds } from "../lib/kinds";

/**
 * What the business runs, typed ahead over hundreds of kinds by their name in English, Portuguese, Spanish, French
 * or German; each named in English with the browser's own language beside it, greyed. Past what the list has, the
 * last line offers the owner's own words. Arrow keys move, Enter picks, Escape closes the list.
 */
export function KindPicker({
  id,
  text,
  onText,
  onPick,
  onOwnWords,
  placeholder = "Tattoo studio, dentist, surf school…",
}: {
  id: string;
  text: string;
  onText: (text: string) => void;
  onPick: (kind: BusinessKind) => void;
  /** The owner's own words, for a kind the list lacks. */
  onOwnWords: (words: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `${id}-list`;
  const browser = typeof navigator === "undefined" ? undefined : navigator.language;
  const matches = useMemo(() => (open ? matchKinds(text, 8, browser) : []), [open, text, browser]);
  const words = text.trim();
  // The owner's own words, once nothing in the list is exactly what they typed.
  const exact = matches.some((k) => k.names.en.toLowerCase() === words.toLowerCase());
  const own = open && words.length > 1 && !exact;
  const count = matches.length + (own ? 1 : 0);
  const pick = (i: number) => {
    const kind = matches[i];
    if (kind) onPick(kind);
    else if (own) onOwnWords(words);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(count - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open && count > 0) {
        e.preventDefault();
        pick(active);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };
  return (
    <div className="lang-picker kind-picker">
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={open && count > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && count > 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={60}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          onText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {open && count > 0 && (
        <div id={listId} className="lang-list glass-strong" role="listbox" aria-label="Kinds of business">
          {matches.map((k, i) => (
            <div
              key={k.id}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={clsx("lang-option", i === active && "is-active")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {k.names.en}
              {kindAlso(k, browser) && <span className="lang-native">{kindAlso(k, browser)}</span>}
            </div>
          ))}
          {own && (
            <div
              id={`${listId}-${matches.length}`}
              role="option"
              tabIndex={-1}
              aria-selected={active === matches.length}
              className={clsx("lang-option kind-own", active === matches.length && "is-active")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(matches.length);
              }}
              onMouseEnter={() => setActive(matches.length)}
            >
              Something else: “{words}”
            </div>
          )}
        </div>
      )}
    </div>
  );
}
