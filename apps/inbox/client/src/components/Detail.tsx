import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { ArrowLeft, BadgeCheck, Bot, Check, Copy, UserRound } from "lucide-react";
import { useRef, useState } from "react";
import { orderActions, tonesFor } from "../lib/actions";
import { problemOf } from "../lib/api";
import { channelWord, currencyOf, partyName, stateWord, TYPE_CLASS, TYPE_WORD, titleFor } from "../lib/format";
import { usePhone } from "../lib/media";
import { useItem, useReply, useTransition } from "../lib/queries";
import type { Party, Transition } from "../lib/types";
import { ActionBar } from "./ActionBar";
import { ActionConfirm } from "./ActionConfirm";
import { Conversation } from "./Conversation";
import { EventIcon } from "./EventIcon";
import { DetailSkeleton, ErrorState, Toast } from "./Feedback";
import { Details, Fields } from "./Fields";
import { StatePill, TypePill } from "./Pills";
import { Receipts } from "./Receipts";
import { Sheet } from "./Sheet";
import { Timeline } from "./Timeline";

/**
 * One item: the typed card with who is asking, the facts and the valid next actions (happy path
 * first, destructive last), then the conversation and the timeline. A button opens an inline
 * confirmation (a sheet on phones).
 */
export function ItemDetailView({
  id,
  tz,
  business,
  currency,
}: {
  id: string;
  tz: string | undefined;
  business: string | undefined;
  currency: string | undefined;
}) {
  const query = useItem(id);
  const transition = useTransition(id);
  const reply = useReply(id);
  const phone = usePhone();
  const [pending, setPending] = useState<Transition | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) {
    const p = problemOf(query.error);
    const gone = p.status === 404;
    return (
      <ErrorState
        title={gone ? "That item is not here" : "Could not load this item"}
        text={gone ? "It may have been removed, or the link is wrong." : p.detail}
        onRetry={gone ? undefined : () => void query.refetch()}
      >
        <Link to="/" search={(prev) => prev} className="btn btn-primary btn-sm">
          Back to the inbox
        </Link>
      </ErrorState>
    );
  }

  const { item, thread, events, party } = query.data;
  const transitions = orderActions(query.data.transitions);
  const tones = tonesFor(transitions);
  const money = currencyOf(item) ?? currency ?? "EUR";

  const pick = (t: Transition) => {
    setNotice(null);
    transition.reset();
    if (t.event === "answer") {
      replyRef.current?.focus();
      replyRef.current?.scrollIntoView({ block: "center" });
      return;
    }
    setPending(t);
  };

  const run = (t: Transition, input: Record<string, unknown> | undefined) => {
    transition.mutate(
      { event: t.event, ...(input ? { input } : {}), expected_version: item.version },
      {
        onSuccess: (r) => {
          setPending(null);
          setNotice({ tone: "success", text: r.view.human });
        },
        onError: (e) => {
          const p = problemOf(e);
          if (p.code === "version_conflict" || p.code === "wrong_state") void query.refetch();
        },
      },
    );
  };

  const send = async (body: string, internal: boolean) => {
    await reply.mutateAsync({ body, internal });
    setNotice({ tone: "success", text: internal ? "Note added." : "Reply sent." });
  };

  const confirm = pending && (
    <ActionConfirm
      key={pending.event}
      transition={pending}
      tone={tones[transitions.indexOf(pending)] ?? "secondary"}
      item={item}
      currency={money}
      pending={transition.isPending}
      error={transition.error ? problemOf(transition.error) : null}
      showTitle={!phone}
      onSubmit={(input) => run(pending, input)}
      onCancel={() => setPending(null)}
    />
  );

  return (
    <>
      <Link to="/" search={(prev) => prev} className="btn btn-ghost btn-sm back">
        <ArrowLeft className="icon" aria-hidden="true" />
        Inbox
      </Link>
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      <article className="card glass" aria-labelledby="item-title">
        <div className="head">
          <TypePill type={item.type} />
          <StatePill state={item.state} />
          {item.flags.needsHuman && <span className="pill tint-warning">Needs you</span>}
          {item.flags.sandbox && (
            <span className="pill">
              <i className="dot" />
              Sandbox
            </span>
          )}
          <h2 id="item-title">{titleFor(item)}</h2>
        </div>
        <span className={clsx("rule card-rule", `rule-${TYPE_CLASS[item.type]}`)} aria-hidden="true" />
        <WhoLine party={party} channel={item.channel} />
        <Fields item={item} tz={tz} />
        <Receipts receipts={query.data.receipts ?? []} tz={tz} />
        {transitions.length > 0 ? (
          <div className="actions">
            {transitions.map((t, i) => (
              <button
                key={t.event}
                type="button"
                className={clsx("btn", `btn-${tones[i] ?? "secondary"}`)}
                aria-expanded={pending?.event === t.event}
                onClick={() => pick(t)}
              >
                <EventIcon event={t.event} />
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="hint">
            Nothing to do here: this {TYPE_WORD[item.type].toLowerCase()} is {stateWord(item.state).toLowerCase()}.
          </p>
        )}
        {!phone && confirm}
        <Details item={item} tz={tz} />
      </article>
      <Conversation
        entries={thread}
        party={party}
        tz={tz}
        business={business}
        replyRef={replyRef}
        onSend={send}
        sending={reply.isPending}
        error={reply.error ? problemOf(reply.error) : null}
      />
      <Timeline events={events} type={item.type} tz={tz} />
      {phone && <ActionBar transitions={transitions} tones={tones} onPick={pick} />}
      {phone && pending && (
        <Sheet title={pending.label} onClose={() => setPending(null)}>
          {confirm}
        </Sheet>
      )}
    </>
  );
}

/** Who is asking, how they came in, and how to reach them: copyable, linkable, never for customers' eyes. */
function WhoLine({ party, channel }: { party: Party | undefined; channel: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopied(text));
  };
  const email = party?.email;
  const phone = party?.phone;
  return (
    <div className="who-line">
      {party?.kind === "agent" ? (
        <Bot className="icon" aria-hidden="true" />
      ) : (
        <UserRound className="icon" aria-hidden="true" />
      )}
      <span className="name">{partyName(party)}</span>
      {party?.verified && (
        <span className="pill tint-success pill-xs">
          <BadgeCheck className="icon-xs" aria-hidden="true" />
          Verified
        </span>
      )}
      {party?.kind === "agent" && <span className="pill pill-xs">Agent</span>}
      <span className="sep">·</span>
      <span>via {channelWord(channel)}</span>
      {email && (
        <>
          <span className="sep">·</span>
          <a href={`mailto:${email}`}>{email}</a>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label={copied === email ? "Email copied" : `Copy ${email}`}
            onClick={() => copy(email)}
          >
            {copied === email ? (
              <Check className="icon-sm" aria-hidden="true" />
            ) : (
              <Copy className="icon-sm" aria-hidden="true" />
            )}
          </button>
        </>
      )}
      {phone && (
        <>
          <span className="sep">·</span>
          <a href={`tel:${phone.replace(/\s+/g, "")}`}>{phone}</a>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label={copied === phone ? "Phone copied" : `Copy ${phone}`}
            onClick={() => copy(phone)}
          >
            {copied === phone ? (
              <Check className="icon-sm" aria-hidden="true" />
            ) : (
              <Copy className="icon-sm" aria-hidden="true" />
            )}
          </button>
        </>
      )}
    </div>
  );
}
