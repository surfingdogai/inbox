import clsx from "clsx";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import type { ButtonTone } from "../lib/actions";
import type { Transition } from "../lib/types";
import { EventIcon } from "./EventIcon";
import { Sheet } from "./Sheet";

/**
 * Phone: the valid transitions along the bottom, inside the safe area, one-thumb approve. With `more`,
 * the first goes in its own button and the rest behind a labelled "More", each one named: a row of
 * bare icons is not a choice anyone can read.
 */
export function ActionBar({
  transitions,
  tones,
  onPick,
  more,
}: {
  transitions: readonly Transition[];
  tones: readonly ButtonTone[];
  onPick: (t: Transition) => void;
  more?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (transitions.length === 0) return null;
  const [first, ...rest] = transitions;
  if (more && first) {
    return (
      <div className="bar glass-strong">
        <button
          type="button"
          className={clsx("btn btn-lg bar-main", `btn-${tones[0] ?? "secondary"}`)}
          onClick={() => onPick(first)}
        >
          <EventIcon event={first.event} />
          {first.label}
        </button>
        {rest.length > 0 && (
          <button
            type="button"
            className="btn btn-lg btn-secondary"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <MoreHorizontal className="icon" aria-hidden="true" />
            More
          </button>
        )}
        {open && (
          <Sheet title="More" onClose={() => setOpen(false)}>
            <div className="stack">
              {rest.map((t) => (
                <button
                  key={t.event}
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setOpen(false);
                    onPick(t);
                  }}
                >
                  <EventIcon event={t.event} />
                  {t.label}
                </button>
              ))}
            </div>
          </Sheet>
        )}
      </div>
    );
  }
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
