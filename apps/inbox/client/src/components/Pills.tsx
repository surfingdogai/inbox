import clsx from "clsx";
import { Check } from "lucide-react";
import { stateTone, stateWord, TYPE_CLASS, TYPE_WORD } from "../lib/format";
import type { ItemType } from "../lib/types";

/** Type pills carry the dot; state pills carry meaning (success, warning, danger) or stay neutral. */
export function TypePill({ type, small }: { type: ItemType; small?: boolean | undefined }) {
  const c = TYPE_CLASS[type];
  return (
    <span className={clsx("pill", `tint-${c}`, small && "pill-xs")}>
      <i className={`dot dot-${c}`} />
      {TYPE_WORD[type]}
    </span>
  );
}

export function StatePill({ state, small }: { state: string; small?: boolean | undefined }) {
  const tone = stateTone(state);
  return (
    <span className={clsx("pill", tone !== "neutral" && `tint-${tone}`, small && "pill-xs")}>
      {tone === "success" && <Check className="icon-xs" aria-hidden="true" />}
      {stateWord(state)}
    </span>
  );
}
