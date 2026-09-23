import clsx from "clsx";
import { Bot, Send, StickyNote, User } from "lucide-react";
import { type FormEvent, type RefObject, useState } from "react";
import type { ApiProblem } from "../lib/api";
import { actorWord, channelWord, deliveryWord, formatDateTime, initials, partyName } from "../lib/format";
import type { Party, ThreadEntry } from "../lib/types";

/** Thread entries in, out and internal notes, then a reply box that also takes a private note. */
export function Conversation({
  entries,
  party,
  tz,
  business,
  replyRef,
  onSend,
  sending,
  error,
}: {
  entries: readonly ThreadEntry[];
  party: Party | undefined;
  tz: string | undefined;
  business: string | undefined;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  onSend: (body: string, internal: boolean) => Promise<void>;
  sending: boolean;
  error: ApiProblem | null;
}) {
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    try {
      await onSend(body, internal);
      setText("");
    } catch {
      // The problem is shown under the box.
    }
  };

  return (
    <div className="stack">
      <div className="eyebrow">Conversation</div>
      {entries.length === 0 && <p className="hint">No messages on this item yet.</p>}
      {entries.map((e) => (
        <Entry key={e.id} entry={e} party={party} tz={tz} business={business} />
      ))}
      <form className="reply" onSubmit={submit}>
        <label className="label" htmlFor="reply-box">
          {internal ? "Internal note" : `Reply to ${partyName(party)}`}
        </label>
        <textarea
          id="reply-box"
          ref={replyRef}
          className="input"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            internal ? "A private note for the team. The customer never sees it." : `Write to ${partyName(party)}…`
          }
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "reply-error" : undefined}
        />
        <div className="rowx">
          <label className="check">
            <span className="switch">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
              <span />
            </span>
            Internal note
          </label>
          <span className="sp" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || sending}>
            {sending ? <span className="spinner" aria-hidden="true" /> : <Send className="icon" aria-hidden="true" />}
            {internal ? "Add note" : "Send reply"}
          </button>
        </div>
        {error && (
          <p className="hint error" id="reply-error" role="alert">
            {error.detail}
          </p>
        )}
      </form>
    </div>
  );
}

function Entry({
  entry,
  party,
  tz,
  business,
}: {
  entry: ThreadEntry;
  party: Party | undefined;
  tz: string | undefined;
  business: string | undefined;
}) {
  const when = formatDateTime(entry.at, tz);
  const who =
    entry.direction === "in"
      ? `${partyName(party)} · via ${channelWord(entry.channel)} · ${when}`
      : entry.direction === "note"
        ? `Internal note · ${actorWord(entry.actor)} · ${when}`
        : `${business || "You"} · ${when}`;
  return (
    <div className={clsx("msg", `msg-${entry.direction}`)}>
      <span className="avatar" aria-hidden="true">
        {entry.direction === "in" ? (
          party?.kind === "agent" ? (
            <Bot className="icon-sm" />
          ) : party?.name ? (
            initials(party.name)
          ) : (
            <User className="icon-sm" />
          )
        ) : entry.direction === "note" ? (
          <StickyNote className="icon-sm" />
        ) : (
          initials(business || "You")
        )}
      </span>
      <div>
        <div className="who">{who}</div>
        <div className="b row-glass">{entry.body}</div>
        {entry.direction === "out" && <Delivery entry={entry} tz={tz} />}
      </div>
    </div>
  );
}

/** Under a reply: what became of its email. "Sending…" until the mail service took it, never "sent" before. */
function Delivery({ entry, tz }: { entry: ThreadEntry; tz: string | undefined }) {
  const d = entry.delivery;
  // No email yet: a reply just written is on its way; an old one (from before emails were kept) says nothing.
  if (!d) return Date.now() - Date.parse(entry.at) < 15 * 60_000 ? <div className="hint">Sending…</div> : null;
  const bad = d.status === "failed" || d.status === "skipped" || d.status === "retrying";
  return (
    <div className={clsx("hint", bad && "error")} role={bad ? "status" : undefined}>
      {deliveryWord(d, tz)}
    </div>
  );
}
