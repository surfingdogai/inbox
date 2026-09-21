import clsx from "clsx";
import type { ButtonTone } from "../lib/actions";
import type { Transition } from "../lib/types";
import { EventIcon } from "./EventIcon";

/** Phone: the valid transitions along the bottom, inside the safe area, one-thumb approve. */
export function ActionBar({
  transitions,
  tones,
  onPick,
}: {
  transitions: readonly Transition[];
  tones: readonly ButtonTone[];
  onPick: (t: Transition) => void;
}) {
  if (transitions.length === 0) return null;
  return (
    <div className="bar glass-strong">
      {transitions.map((t, i) => {
        const tone = tones[i] ?? "secondary";
        return i === 0 ? (
          <button
            key={t.event}
            type="button"
            className={clsx("btn btn-lg bar-main", `btn-${tone}`)}
            onClick={() => onPick(t)}
          >
            <EventIcon event={t.event} />
            {t.label}
          </button>
        ) : (
          <button
            key={t.event}
            type="button"
            className={clsx("btn btn-lg btn-icon bar-icon", `btn-${tone}`)}
            aria-label={t.label}
            title={t.label}
            onClick={() => onPick(t)}
          >
            <EventIcon event={t.event} />
          </button>
        );
      })}
    </div>
  );
}
