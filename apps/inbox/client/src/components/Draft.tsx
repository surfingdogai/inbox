import { FilePenLine } from "lucide-react";
import { problemOf } from "../lib/api";
import { type DraftView, draftDetails, notSentWords, termsLine } from "../lib/drafts";
import { byWord } from "../lib/format";
import { useDraft } from "../lib/queries";
import { Toast } from "./Feedback";

export { BREACH_WORDS, breachWords } from "../lib/drafts";

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
        {byWord(draft.by, draft.by.kind)} would offer: <b>{termsLine(draft.terms, tz) || "an offer"}</b>.{" "}
        {notSentWords(draft.breaches)}
      </p>
      {/* Everything else the customer would read, and its own words to them in full: "as it is" means all of it. */}
      {draftDetails(draft.terms, tz).length > 0 && (
        <ul className="hint">
          {draftDetails(draft.terms, tz).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {draft.terms.notes?.trim() && (
        <p className="hint">Its words to the customer, which no person here wrote: “{draft.terms.notes.trim()}”</p>
      )}
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
