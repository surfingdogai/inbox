import { App as CapApp } from "@capacitor/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDay, formatWhen, partyName, stateWord } from "../../../inbox/client/src/lib/format";
import {
  ACT_LABEL,
  actsFor,
  alreadyDone,
  byWords,
  quoteLine,
  type SpamAct,
  toastFor,
  toastLift,
  UNDO_MS,
  warnSentence,
} from "../../../inbox/client/src/lib/spam";
import type { ItemDetail } from "../../../inbox/client/src/lib/types";
import { useApp } from "../context";
import type { Slots } from "../lib/client";
import { InboxError } from "../lib/session";
import { Waiting } from "../lib/undo";
import {
  actionsFor,
  agoSentence,
  calendarWords,
  fulfilFact,
  holdNotes,
  money,
  requestWord,
  sentPhrase,
} from "../lib/view";
import { CheckIcon, ChevronLeft, CloseIcon, MoreIcon } from "./icons";

/** What the "…" menu may do in one press: answers that need no words or times typed. */
const ONE_PRESS = new Set([
  "mark_spam",
  "unspam",
  "cancel",
  "no_show",
  "complete",
  "fulfil",
  "start_fulfilment",
  "retract",
  "retract_change",
  "reopen",
  "approve",
  "reject",
  "accept_change",
  "decline_change",
]);

/**
 * One request (the approved Item screen): who and what, the customer's words, an optional reply, and
 * the three answers: accept, propose another time, decline. Opened from a notification's action, the
 * action waits on a confirm sheet: nothing is done until the owner presses it here.
 */
export function Item({
  id,
  action,
  hint,
}: {
  id: string;
  action?: string | undefined;
  hint?: { readonly title: string; readonly body: string } | undefined;
}) {
  const app = useApp();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [tried, setTried] = useState(false);
  const [reply, setReply] = useState("");
  const [sheet, setSheet] = useState<"propose" | "confirm" | "decline" | "more" | null>(null);
  const [other, setOther] = useState<{ event: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Android's back button closes an open sheet before it leaves the item.
  const { onBack } = app;
  const open = sheet !== null || other !== null;
  useEffect(
    () =>
      open
        ? onBack(() => {
            setSheet(null);
            setOther(null);
            return true;
          })
        : undefined,
    [open, onBack],
  );
  const tz = app.me?.business.timezone;

  const load = useCallback(async () => {
    setDetail(await app.loadItem(id));
    setTried(true);
  }, [app, id]);
  useEffect(() => {
    void load();
  }, [load]);
  // Not on the phone and the inbox out of reach: tried again the moment the connection is back.
  useEffect(() => {
    if (detail) return;
    const again = () => void load();
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [detail, load]);
  const actions = useMemo(() => (detail ? actionsFor(detail, tz) : null), [detail, tz]);
  const spamActs = useMemo(() => (detail ? actsFor(detail) : []), [detail]);
  const [undo, setUndo] = useState<{ act: SpamAct; text: string } | null>(null);
  // What a press needs when it is sent, read as it is then: the screen may have drawn itself again
  // many times in its six seconds, and that must never send it.
  const appRef = useRef(app);
  appRef.current = app;
  const detailRef = useRef(detail);
  detailRef.current = detail;

  /** Sends what waited for Undo: the filter's own calls, or the item's transition where it is one. */
  const send = async (act: SpamAct) => {
    const a = appRef.current;
    const d = detailRef.current;
    if (!d || !a.client) return;
    const key = crypto.randomUUID();
    const screen = d.spam?.screen ?? null;
    try {
      if (act === "let_in" || (act === "not_spam" && d.item.state !== "spam"))
        await a.client.spamAct(d.item.id, "let-in", key);
      else if (act === "looks_fine") await a.client.spamAct(d.item.id, "looks-fine", key);
      else if (act === "spam" && (screen === "held" || screen === "pending"))
        await a.client.spamAct(d.item.id, "spam", key);
      else
        await a.act(
          d.item.id,
          "transition",
          { event: act === "spam" ? "mark_spam" : "unspam", expected_version: d.item.version },
          ACT_LABEL[act],
        );
      void a.refresh();
      const next = await a.loadItem(d.item.id);
      detailRef.current = next;
      setDetail(next);
    } catch (e) {
      // Let in already, by an answer given meanwhile: what the owner asked for is done.
      if (e instanceof InboxError && alreadyDone(act, e)) {
        void a.refresh();
        return;
      }
      a.toast(
        e instanceof InboxError && e.offline
          ? "You're offline: press it again when you're back."
          : e instanceof Error
            ? e.message
            : "Not done.",
      );
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const waiting = useRef<Waiting<SpamAct> | null>(null);
  waiting.current ??= new Waiting<SpamAct>(
    (act) => sendRef.current(act),
    UNDO_MS,
    () => setUndo(null),
  );
  // Leaving the item sends what waits, and so does the app going to the background: Undo is only for
  // the six seconds on this screen. Only then: these listeners are set once, for the screen's life.
  useEffect(() => {
    const q = waiting.current;
    const hidden = () => {
      if (document.visibilityState === "hidden") q?.now();
    };
    const away = () => q?.now();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", away);
    const paused = CapApp.addListener("pause", away).catch(() => null);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", away);
      void paused.then((sub) => sub?.remove());
      q?.now();
    };
  }, []);
  // The answer buttons along the bottom: the Undo toast sits above them, never over them.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [lift, setLift] = useState<number | null>(null);
  const spamAct = (act: SpamAct) => {
    if (!detail) return;
    waiting.current?.start(act);
    const bar = barRef.current?.getBoundingClientRect();
    setLift(toastLift(bar && bar.height > 0 ? bar.top : null, window.innerHeight));
    setUndo({ act, text: toastFor(act, detail).text });
  };
  const cancelAct = () => waiting.current?.undo();
  useEffect(() => {
    if (action && actions?.primary?.event === action) setSheet("confirm");
    else if (action === "propose" && actions?.propose) setSheet("propose");
  }, [action, actions]);

  if (!detail)
    return (
      <div className="screen">
        <header className="head" style={{ paddingLeft: 12, paddingRight: 12 }}>
          <div className="head-row">
            <button type="button" className="back" onClick={app.back}>
              <ChevronLeft />
              Inbox
            </button>
          </div>
        </header>
        <main className="body" style={{ padding: "4px 20px 20px", gap: 16 }}>
          {hint && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <h1 style={{ fontSize: 26 }}>{hint.title}</h1>
              {hint.body && <div className="sub">{hint.body}</div>}
            </div>
          )}
          {tried && (
            <div className="empty">
              <b>This request isn't on this phone yet.</b>
              It opens when you're back online.
            </div>
          )}
        </main>
      </div>
    );
  const item = detail.item;
  const name = item.type === "order" ? partyName(detail.party) : partyName(detail.party);
  const words = [...detail.thread].filter((t) => t.body.trim()).slice(-3);
  const first =
    words.length === 0
      ? item.type === "message"
        ? item.payload.text
        : item.type === "quote_request"
          ? item.payload.description
          : item.type === "booking" || item.type === "order"
            ? item.payload.notes
            : undefined
      : undefined;

  const run = async (event: string, label: string, input?: Record<string, unknown>) => {
    setBusy(true);
    try {
      // A press still waiting for its Undo goes first (a Let it in before the answer it allows), and
      // the answer is sent against the version it left.
      await waiting.current?.now();
      await app.act(
        item.id,
        "transition",
        { event, expected_version: detailRef.current?.item.version ?? item.version, ...(input ? { input } : {}) },
        label,
      );
      if (reply.trim()) await app.act(item.id, "reply", { body: reply.trim(), internal: false }, "Reply");
      setReply("");
      setSheet(null);
      await app.refresh();
      app.back();
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await app.act(item.id, "reply", { body: reply.trim(), internal: false }, "Reply");
      setReply("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <header className="head" style={{ paddingLeft: 12, paddingRight: 12 }}>
        <div className="head-row">
          <button type="button" className="back" onClick={app.back}>
            <ChevronLeft />
            Inbox
          </button>
          <button type="button" className="icon-btn bare" aria-label="More" onClick={() => setSheet("more")}>
            <MoreIcon />
          </button>
        </div>
      </header>
      <main className="body" style={{ padding: "4px 20px 20px", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className={`chip ${item.type}`} style={{ alignSelf: "flex-start" }}>
            {requestWord(item)}
          </span>
          <h1 style={{ fontSize: 26 }}>{name}</h1>
          <div className="sub">
            {sentPhrase(item)} · {agoSentence(item.createdAt)}
          </div>
        </div>
        {/* Why a kitchen's order waits for the owner (ADR-040), as the owner app says it: before Accept. */}
        {holdNotes(detail).map((note) => (
          <p key={note} className="hold" role="note">
            {note}
          </p>
        ))}
        {detail.spam && <SpamWhy detail={detail} tz={tz} acts={spamActs} onAct={spamAct} />}
        <Facts detail={detail} tz={tz} />
        {(words.length > 0 || first) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {first && <div className="bubble">{first}</div>}
            {words.map((t) => (
              <div key={t.id} className={`bubble${t.direction === "in" ? "" : " out"}`}>
                {t.body}
              </div>
            ))}
          </div>
        )}
        {item.closedAt === null && (
          <label className="field">
            <span className="sr-only">Reply</span>
            <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply" />
            {actions?.primary ? (
              <small>Optional</small>
            ) : (
              <button
                type="button"
                className="btn link"
                disabled={busy || !reply.trim()}
                onClick={() => void sendReply()}
              >
                Send
              </button>
            )}
          </label>
        )}
      </main>
      {actions && (actions.primary || actions.propose || actions.decline) && item.closedAt === null && (
        <div className="actions" ref={barRef}>
          {actions.primary && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => actions.primary && void run(actions.primary.event, actions.primary.label)}
            >
              {actions.primary.label}
            </button>
          )}
          {(actions.propose || actions.decline) && (
            <div className="row">
              {actions.propose && (
                <button type="button" className="btn" disabled={busy} onClick={() => setSheet("propose")}>
                  {actions.propose.label}
                </button>
              )}
              {actions.decline && (
                <button type="button" className="btn decline" disabled={busy} onClick={() => setSheet("decline")}>
                  Decline
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {sheet === "propose" && item.type === "booking" && (
        <Propose
          serviceId={item.payload.reservationFor.serviceId}
          serviceName={item.payload.reservationFor.name}
          tz={tz}
          busy={busy}
          onClose={() => setSheet(null)}
          onSend={(startTime, endTime, note, label) =>
            void run("propose", label, { startTime, endTime, ...(note ? { note } : {}) })
          }
        />
      )}
      {sheet === "confirm" && actions?.primary && (
        <Confirm
          title={`${actions.primary.label}?`}
          text={`${requestWord(item)} from ${name}.`}
          yes={actions.primary.label}
          busy={busy}
          onYes={() => actions.primary && void run(actions.primary.event, actions.primary.label)}
          onNo={() => setSheet(null)}
        />
      )}
      {sheet === "more" && (
        <More
          detail={detail}
          origin={app.active?.origin ?? ""}
          skip={[
            actions?.primary?.event,
            actions?.propose?.event,
            actions?.decline?.event,
            ...(spamActs.includes("spam") ? ["mark_spam"] : []),
            ...(spamActs.includes("not_spam") ? ["unspam"] : []),
          ]}
          onClose={() => setSheet(null)}
          onPick={(t) => {
            setSheet(null);
            // Spam is one press with Undo, as on the computer (ADR-041 §12).
            if (t.event === "mark_spam" || t.event === "unspam") {
              spamAct(t.event === "mark_spam" ? "spam" : "not_spam");
              return;
            }
            setOther(t);
          }}
          onCopied={() => {
            setSheet(null);
            app.toast("Link copied. It opens this request in your inbox on a computer.");
          }}
        />
      )}
      {other && (
        <Confirm
          title={`${other.label}?`}
          text={`${requestWord(item)} from ${name}.`}
          yes={other.label}
          busy={busy}
          onYes={() => {
            const t = other;
            setOther(null);
            void run(t.event, t.label);
          }}
          onNo={() => setOther(null)}
        />
      )}
      {undo && (
        <div className="toast undo" role="status" style={lift !== null ? { bottom: lift } : undefined}>
          <span>{undo.text}</span>
          <button type="button" onClick={cancelAct}>
            Undo
          </button>
        </div>
      )}
      {sheet === "decline" && actions?.decline && (
        <Confirm
          title="Decline this request?"
          text={`${name} is told the business can't take it.`}
          yes="Decline"
          busy={busy}
          onYes={() => actions.decline && void run(actions.decline.event, "Decline")}
          onNo={() => setSheet(null)}
        />
      )}
    </div>
  );
}

/** The "…" menu: the other answers one press gives, and the request's link for the computer. */
function More(p: {
  detail: ItemDetail;
  origin: string;
  skip: readonly (string | undefined)[];
  onClose: () => void;
  onPick: (t: { event: string; label: string }) => void;
  onCopied: () => void;
}) {
  const open = p.detail.item.closedAt === null;
  const others = open ? p.detail.transitions.filter((t) => ONE_PRESS.has(t.event) && !p.skip.includes(t.event)) : [];
  const link = `${p.origin}/i/${encodeURIComponent(p.detail.item.id)}`;
  return (
    <>
      <div className="scrim" onClick={p.onClose} aria-hidden="true" />
      <section className="sheet" role="dialog" aria-label="More">
        <div className="grabber" aria-hidden="true" />
        {others.map((t) => (
          <button key={t.event} type="button" className="btn" onClick={() => p.onPick(t)}>
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(link)
              .then(p.onCopied)
              .catch(() => undefined)
          }
        >
          Copy the link for your computer
        </button>
        <button type="button" className="btn quiet" onClick={p.onClose}>
          Close
        </button>
      </section>
    </>
  );
}

function Facts({ detail, tz }: { detail: ItemDetail; tz: string | undefined }) {
  const item = detail.item;
  const rows: [string, string][] = [];
  const calendar = calendarWords(detail, tz);
  if (item.type === "booking") {
    rows.push(["When", formatWhen(item.payload.startTime, item.payload.endTime, tz)]);
    rows.push([
      "Service",
      [item.payload.reservationFor.name, item.payload.totalPrice ? money(item.payload.totalPrice) : ""]
        .filter(Boolean)
        .join(" · "),
    ]);
    if (item.payload.partySize && item.payload.partySize > 1) rows.push(["People", String(item.payload.partySize)]);
  } else if (item.type === "order") {
    for (const l of item.payload.orderedItem.slice(0, 4)) rows.push([`${l.quantity} ×`, l.name]);
    if (item.payload.orderedItem.length > 4) rows.push(["", `and ${item.payload.orderedItem.length - 4} more`]);
    rows.push(["Total", money(item.payload.totalPrice)]);
    const d = item.payload.delivery;
    if (d)
      rows.push([
        d.method === "pickup" ? "Pick-up" : d.method === "delivery" ? "Delivery" : "Digital",
        d.when ? formatDay(d.when, tz) : "",
      ]);
    // A kitchen's order for a time (ADR-040): how, and its slot.
    const fulfil = fulfilFact(detail, tz);
    if (fulfil) rows.push(fulfil);
  } else if (item.type === "quote_request") {
    rows.push(["For", item.payload.itemOffered.name]);
    if (item.payload.budget) rows.push(["Budget", money(item.payload.budget)]);
    if (item.payload.requestedFor) rows.push(["When", formatDay(item.payload.requestedFor, tz)]);
  } else if (item.type === "refund") {
    rows.push(["Amount", money(item.payload.amount)]);
  }
  // An open booking request says where it sits in the calendar: what the owner needs to accept it.
  if (!calendar) rows.push(["Status", stateWord(item.state)]);
  return (
    <div className="facts">
      {rows.map(([k, v]) => (
        <div key={`${k}${v}`}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
      {calendar && (
        <div>
          <span>Calendar</span>
          {calendar.free ? (
            <span className="free">
              <CheckIcon />
              {calendar.short}
            </span>
          ) : (
            <span className="clash">{calendar.short}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Confirm(p: { title: string; text: string; yes: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <>
      <div className="scrim" onClick={p.onNo} aria-hidden="true" />
      <section className="sheet" role="dialog" aria-label={p.title}>
        <div className="grabber" aria-hidden="true" />
        <h2>{p.title}</h2>
        <p className="sub" style={{ margin: 0 }}>
          {p.text}
        </p>
        <button type="button" className="btn primary" disabled={p.busy} onClick={p.onYes}>
          {p.yes}
        </button>
        <button type="button" className="btn quiet" onClick={p.onNo}>
          Not now
        </button>
      </section>
    </>
  );
}

/** Propose another time (the approved sheet): a day, one of its free times, a note. */
function Propose(p: {
  serviceId: string;
  serviceName: string;
  tz: string | undefined;
  busy: boolean;
  onClose: () => void;
  onSend: (startTime: string, endTime: string, note: string, label: string) => void;
}) {
  const { client } = useApp();
  const [slots, setSlots] = useState<Slots | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState(0);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!client) return;
    const from = new Date();
    const to = new Date(from.getTime() + 13 * 86_400_000);
    client
      .slots(p.serviceId, from.toISOString(), to.toISOString())
      .then(setSlots)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Free times could not be read."));
  }, [client, p.serviceId]);
  const days = useMemo(() => {
    const byDay = new Map<string, string[]>();
    for (const s of slots?.slots ?? []) {
      const key = formatDay(s.startTime, p.tz);
      byDay.set(key, [...(byDay.get(key) ?? []), s.startTime]);
    }
    return [...byDay.entries()].slice(0, 4);
  }, [slots, p.tz]);
  const times = days[day]?.[1] ?? [];
  const clock = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: p.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      new Date(iso),
    );
  const chosen = times[time];
  const summary = chosen ? `${days[day]?.[0] ?? ""}, ${clock(chosen)}` : "";
  return (
    <>
      <div className="scrim" onClick={p.onClose} aria-hidden="true" />
      <section className="sheet" role="dialog" aria-label="Propose another time">
        <div className="grabber" aria-hidden="true" />
        <div className="head-row">
          <h2>Propose another time</h2>
          <button type="button" className="icon-btn bare" aria-label="Close" onClick={p.onClose}>
            <CloseIcon />
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {slots && days.length === 0 && <p className="sub">No free times in the next two weeks.</p>}
        {days.length > 0 && (
          <>
            <fieldset className="group">
              <legend className="sub">Day</legend>
              <div className="choices">
                {days.map(([label], i) => (
                  <button
                    type="button"
                    key={label}
                    aria-pressed={day === i}
                    className="choice"
                    onClick={() => {
                      setDay(i);
                      setTime(0);
                    }}
                  >
                    <small>{label.split(" ")[0]}</small>
                    {label.split(" ").slice(1).join(" ")}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="group">
              <legend className="sub">
                Free times for {p.serviceName}
                {slots ? ` (${slots.service.durationMin} min)` : ""}
              </legend>
              <div className="choices">
                {times.slice(0, 12).map((t, i) => (
                  <button type="button" key={t} aria-pressed={time === i} className="choice" onClick={() => setTime(i)}>
                    {clock(t)}
                  </button>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <label className="stacked">
          <span>Note (optional)</span>
          <span className="field">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sorry, that time is taken." />
          </span>
        </label>
        <button
          type="button"
          className="btn primary"
          disabled={!chosen || !slots || p.busy}
          onClick={() => {
            if (!chosen || !slots) return;
            const end = new Date(Date.parse(chosen) + slots.service.durationMin * 60_000).toISOString();
            p.onSend(chosen, end, note.trim(), `Propose ${summary}`);
          }}
        >
          {summary ? `Send · ${summary}` : "Send"}
        </button>
      </section>
    </>
  );
}

/**
 * Why it's here (ADR-041 §11.2, §12): the filter's reason in our words, the passages it found, who
 * decided, and its one-press answers. Nothing a model wrote is ever shown.
 */
function SpamWhy({
  detail,
  tz,
  acts,
  onAct,
}: {
  detail: ItemDetail;
  tz: string | undefined;
  acts: readonly SpamAct[];
  onAct: (act: SpamAct) => void;
}) {
  const spam = detail.spam;
  if (!spam) return null;
  const bySender = spam.released_by === "sender";
  const screen = spam.screen;
  if (!(screen === "held" || screen === "aside" || screen === "warned" || screen === "pending" || bySender))
    if (detail.item.state !== "spam") return null;
  const warn = screen === "warned" ? warnSentence(spam.cause) : "";
  const first = bySender
    ? `The sender confirmed it's them.${spam.reasons[0] ? ` ${spam.reasons[0]}` : ""}`
    : warn || spam.reasons[0] || "You put it aside.";
  return (
    <section className="spam-why" aria-label="Why it's here">
      <div className="spam-why-head">
        <span>Why it's here</span>
        {spam.chip && !bySender && <span className="spam-chip">{spam.chip}</span>}
        {bySender && <span className="spam-chip">Confirmed by the sender</span>}
      </div>
      <p>{first}</p>
      {spam.quotes.map((q) => (
        <p key={q} className="spam-quote">
          {quoteLine(q)}
        </p>
      ))}
      <p className="spam-by">
        {byWords(spam.by)} · {formatDay(spam.at, tz)}
      </p>
      {acts.length > 0 && (
        <div className="spam-acts">
          {acts.map((a, i) => (
            <button key={a} type="button" className={i === 0 ? "btn sm ink" : "btn sm"} onClick={() => onAct(a)}>
              {ACT_LABEL[a]}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
