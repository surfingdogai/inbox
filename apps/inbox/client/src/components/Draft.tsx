import { FilePenLine } from "lucide-react";
import { problemOf } from "../lib/api";
import { byWord, formatMoney, formatWhen } from "../lib/format";
import { useDraft } from "../lib/queries";
import type { ItemDetail } from "../lib/types";
import { Toast } from "./Feedback";

type DraftView = NonNullable<ItemDetail["draft"]>;

/** Each limit a draft is outside, in the owner's words: the owner may read what automation may not. */
export const BREACH_WORDS: Readonly<Record<string, string>> = {
  below_floor: "under your lowest price, or more off than you allow",
  above_list: "above the customer's price",
  counter_priced: "answers the customer's own price with another",
  custom_line: "puts a price on what your catalogue does not price",
  time_moved: "further from the time they asked for than you allow",
  delivery_later: "delivers later than they asked",
  worse_than_before: "dearer than what you last offered them",
  rounds_exhausted: "past the last round of back and forth",
  change_not_allowed: "asks them for a change to what was agreed",
  over_approval_value: "above the value you accept yourself",
  amount_named: "names an amount of money you have not offered",
};

export function breachWords(breaches: readonly string[]): string {
  return breaches.map((b) => BREACH_WORDS[b] ?? b.replaceAll("_", " ")).join("; ");
}

/** What the customer would be offered, in one line: the time, the lines, the total. */
function termsLine(t: DraftView["terms"], tz: string | undefined): string {
  const parts: string[] = [];
  if (t.startTime) parts.push(formatWhen(t.startTime, t.endTime, tz));
  if (t.lines?.length) parts.push(t.lines.map((l) => `${l.quantity ?? 1} × ${l.name ?? ""}`.trim()).join(", "));
  if (t.totalPrice) parts.push(formatMoney(t.totalPrice));
  return parts.join(" · ");
}

/**
 * What automation — the owner's AI, a rule, another system's key — would have offered outside the
 * owner's limits (ADR-018 §4). Nothing went to the customer: the owner sends it as it is, makes their
 * own offer with the actions below, or drops it.
 */
export function DraftCard({
  itemId,
  draft,
  tz,
  onDone,
}: {
  itemId: string;
  draft: DraftView;
  tz: string | undefined;
  onDone: (text: string) => void;
}) {
  const { send, drop } = useDraft(itemId);
  const busy = send.isPending || drop.isPending;
  const error = send.error ?? drop.error;
  return (
    <div className="stack draft">
      <div className="eyebrow">
        <FilePenLine className="icon-xs" aria-hidden="true" /> A draft waits for you
      </div>
      <p>
        {byWord(draft.by, draft.by.kind)} would offer: <b>{termsLine(draft.terms, tz) || "an offer"}</b>. Not sent: it
        is {breachWords(draft.breaches)}.
      </p>
      {draft.stale && (
        <p className="hint">The item has moved since, so it cannot go as it is: make your own offer, or drop it.</p>
      )}
      {error && <Toast tone="danger" text={problemOf(error).detail} />}
      <div className="actions">
        {!draft.stale && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => send.mutate(draft.id, { onSuccess: (r) => onDone(r.view.human) })}
          >
            Send as it is
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => drop.mutate(draft.id, { onSuccess: () => onDone("Draft dropped.") })}
        >
          Drop it
        </button>
      </div>
    </div>
  );
}
