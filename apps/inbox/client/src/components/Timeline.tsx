import clsx from "clsx";
import { byWord, eventWord, formatDateTime, stateTone, TYPE_CLASS } from "../lib/format";
import type { ItemEvent, ItemType } from "../lib/types";

/** Every transition as one line: what happened, by whom, why, when. Dots take the colour of the outcome. */
export function Timeline({
  events,
  type,
  tz,
}: {
  events: readonly ItemEvent[];
  type: ItemType;
  tz: string | undefined;
}) {
  return (
    <div className="stack">
      <div className="eyebrow">Timeline</div>
      <div className="timeline">
        {events.map((e) => {
          const tone = e.event === "create" || e.event === "flags" ? "neutral" : stateTone(e.to);
          const dot = tone === "neutral" ? `dot-${TYPE_CLASS[type]}` : `dot-${tone}`;
          return (
            <div className="event" key={e.seq}>
              <i className={clsx("dot", dot)} />
              <span>
                <b>{eventWord(e.event)}</b> by {byWord(e.by, e.actor)}
                {e.reason ? ` — ${e.reason}` : ""}
              </span>
              <time dateTime={e.at}>{formatDateTime(e.at, tz)}</time>
            </div>
          );
        })}
      </div>
      <span className={clsx("rule timeline-end", `rule-${TYPE_CLASS[type]}`)} aria-hidden="true" />
    </div>
  );
}
