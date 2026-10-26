import clsx from "clsx";
import { ChefHat, ShieldAlert } from "lucide-react";
import { problemOf } from "../lib/api";
import {
  fulfilLine,
  HOLD_WORDS,
  nextStages,
  type OrderItem,
  STAGE_ACTIONS,
  STAGE_WORDS,
  tipLine,
  useProgress,
} from "../lib/food";
import { formatClock } from "../lib/format";

/**
 * A kitchen's order (ADR-040): each line's options and note, how and when it is collected or delivered,
 * the tip, why it waits for a person (allergens not confirmed come first), and the kitchen's progress:
 * Start preparing, Mark ready, Out for delivery. Progress lives inside fulfilling; the order's own actions are the
 * buttons below as for any order.
 */
export function OrderBlock({
  item,
  tz,
  onDone,
}: {
  item: OrderItem;
  tz: string | undefined;
  onDone: (text: string) => void;
}) {
  const progress = useProgress();
  const p = item.payload;
  const lines = p.orderedItem.filter((l) => (l.options?.length ?? 0) > 0 || l.note || l.brief);
  const fulfil = fulfilLine(p.fulfil, tz);
  const tip = tipLine(p.tip);
  const holds = p.kitchen?.hold ?? [];
  const stages = nextStages(item.state, p.progress, p.fulfil?.method);
  if (!fulfil && lines.length === 0 && holds.length === 0 && !p.progress && !tip) return null;
  return (
    <div className="kitchen-order stack">
      {holds.includes("allergens_unconfirmed") && (
        <p className="kitchen-hold is-allergens" role="note">
          <ShieldAlert className="icon-sm" aria-hidden="true" />
          {HOLD_WORDS.allergens_unconfirmed}
        </p>
      )}
      {holds
        .filter((h) => h !== "allergens_unconfirmed" && h !== "owner_accepts")
        .map((h) => (
          <p key={h} className="kitchen-hold" role="note">
            {HOLD_WORDS[h] ?? h}
          </p>
        ))}
      {lines.length > 0 && (
        <ul className="kitchen-lines">
          {keyed(lines).map(([key, l]) => (
            <li key={key}>
              <b>
                {l.quantity} × {l.name}
              </b>
              {(l.options?.length ?? 0) > 0 && (
                <span className="kitchen-options">
                  {(l.options ?? [])
                    .map((o) =>
                      o.portion && o.portion !== "whole"
                        ? `${o.name ?? o.choiceId} (${o.portion} half)`
                        : (o.name ?? o.choiceId),
                    )
                    .join(", ")}
                </span>
              )}
              {l.note && <span className="kitchen-note">“{l.note}”</span>}
              {l.brief?.message && <span className="kitchen-note">Writing: “{l.brief.message}”</span>}
              {(l.brief?.servings || l.brief?.flavour) && (
                <span className="kitchen-options">
                  {[l.brief.flavour, l.brief.servings ? `for ${l.brief.servings}` : null].filter(Boolean).join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <dl className="fields">
        {fulfil && (
          <div>
            <dt>For</dt>
            <dd>{fulfil}</dd>
          </div>
        )}
        {tip && (
          <div>
            <dt>Tip</dt>
            <dd>{tip}</dd>
          </div>
        )}
        {p.progress && (
          <div>
            <dt>Kitchen</dt>
            <dd>
              {STAGE_WORDS[p.progress.stage]} · {formatClock(p.progress.at, tz)}
              {p.progress.etaAt ? ` · expected ${formatClock(p.progress.etaAt, tz)}` : ""}
            </dd>
          </div>
        )}
      </dl>
      {stages.length > 0 && (
        <div className="kitchen-stages">
          <ChefHat className="icon-sm" aria-hidden="true" />
          {stages.map((s, i) => (
            <button
              key={s}
              type="button"
              className={clsx("btn btn-sm", i === stages.length - 1 ? "btn-secondary" : "btn-ghost")}
              disabled={progress.isPending}
              onClick={() =>
                progress.mutate(
                  { itemId: item.id, stage: s },
                  { onSuccess: () => onDone(`${STAGE_WORDS[s]}: the customer's agent can see it.`) },
                )
              }
            >
              {STAGE_ACTIONS[s]}
            </button>
          ))}
        </div>
      )}
      {progress.error && <p className="hint error">{problemOf(progress.error).detail}</p>}
    </div>
  );
}

type Line = OrderItem["payload"]["orderedItem"][number];

/** Each line with a key: what makes it this line (name, options, note), and a count for two the same. */
function keyed(lines: readonly Line[]): [string, Line][] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const options = (l.options ?? []).map((o) => `${o.groupId}:${o.choiceId}:${o.portion ?? ""}`).join(",");
    const base = `${l.sku ?? l.name}|${options}|${l.note ?? ""}|${l.brief?.message ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return [`${base}#${n}`, l];
  });
}
