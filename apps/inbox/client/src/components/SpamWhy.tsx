import clsx from "clsx";
import { useState } from "react";
import { formatDateTime } from "../lib/format";
import { ACT_LABEL, byWords, quoteLine, type SpamAct, warnSentence } from "../lib/spam";
import type { ItemDetail } from "../lib/types";

/**
 * Why it's here (ADR-029 §11.2): the strongest cause in our words, the rest a tap away, the passages
 * the code found in the message (escaped like every text here), who decided and when, and the acts.
 */
export function WhyHere({
  view,
  tz,
  acts,
  onAct,
}: {
  view: ItemDetail;
  tz: string | undefined;
  acts: readonly SpamAct[];
  onAct: (act: SpamAct) => void;
}) {
  const [more, setMore] = useState(false);
  const spam = view.spam;
  if (!spam) return null;
  const screen = spam.screen;
  const bySender = spam.released_by === "sender";
  const shown = screen === "held" || screen === "aside" || screen === "warned" || screen === "pending" || bySender;
  if (!shown && view.item.state !== "spam") return null;
  const warn = screen === "warned" ? warnSentence(spam.cause) : "";
  const lines = bySender
    ? [`The sender confirmed it's them.${spam.reasons[0] ? ` ${spam.reasons[0]}` : ""}`, ...spam.reasons.slice(1)]
    : warn
      ? [warn, ...spam.reasons]
      : spam.reasons.length > 0
        ? [...spam.reasons]
        : [screen === "pending" ? "It is being checked." : "You put it aside."];
  const [first, ...rest] = lines;
  const chip = bySender ? "Confirmed by the sender" : spam.chip;
  return (
    <section className="spam-why" aria-label="Why it's here">
      <div className="spam-why-head">
        <h3 className="sec">Why it's here</h3>
        {chip && <span className="spam-chip">{chip}</span>}
      </div>
      <p className="spam-why-first">
        {first}
        {rest.length > 0 && !more && (
          <>
            {" "}
            <button type="button" className="link-button" aria-expanded={false} onClick={() => setMore(true)}>
              and {rest.length} more
            </button>
          </>
        )}
      </p>
      {more && rest.length > 0 && (
        <ul className="spam-why-rest">
          {rest.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {spam.quotes.map((q) => (
        <p key={q} className="spam-quote">
          {quoteLine(q)}
        </p>
      ))}
      <p className="spam-by">
        {byWords(spam.by)} · {formatDateTime(spam.at, tz)}
      </p>
      {acts.length > 0 && (
        <div className="spam-acts">
          {acts.map((a, i) => (
            <button
              key={a}
              type="button"
              className={clsx("btn btn-sm", i === 0 ? "btn-primary" : "btn-secondary")}
              onClick={() => onAct(a)}
            >
              {ACT_LABEL[a]}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
