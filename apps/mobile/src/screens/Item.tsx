import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatDay,
  formatMoney,
  formatWhen,
  partyName,
  relativeTime,
  stateWord,
} from "../../../inbox/client/src/lib/format";
import type { ItemDetail } from "../../../inbox/client/src/lib/types";
import { useApp } from "../context";
import type { Slots } from "../lib/client";
import { actionsFor, channelPhrase, requestWord } from "../lib/view";
import { ChevronLeft, CloseIcon } from "./icons";

/**
 * One request (the approved Item screen): who and what, the customer's words, an optional reply, and
 * the three answers: accept, propose another time, decline. Opened from a notification's action, the
 * action waits on a confirm sheet: nothing is done until the owner presses it here.
 */
export function Item({ id, action }: { id: string; action?: string | undefined }) {
  const app = useApp();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [reply, setReply] = useState("");
  const [sheet, setSheet] = useState<"propose" | "confirm" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = app.me?.business.timezone;

  const load = useCallback(async () => setDetail(await app.loadItem(id)), [app, id]);
  useEffect(() => {
    void load();
  }, [load]);
  const actions = useMemo(() => (detail ? actionsFor(detail, tz) : null), [detail, tz]);
  useEffect(() => {
    if (action && actions?.primary?.event === action) setSheet("confirm");
    else if (action === "propose" && actions?.propose) setSheet("propose");
  }, [action, actions]);

  if (!detail) return <div className="screen" />;
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
      await app.act(
        item.id,
        "transition",
        { event, expected_version: item.version, ...(input ? { input } : {}) },
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
        </div>
      </header>
      <main className="body" style={{ padding: "4px 20px 20px", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className={`chip ${item.type}`} style={{ alignSelf: "flex-start" }}>
            {requestWord(item)}
          </span>
          <h1 style={{ fontSize: 26 }}>{name}</h1>
          <div className="sub">
            {channelPhrase(item).replace(/^./, (c) => c.toUpperCase())} · {relativeTime(item.createdAt)}
          </div>
        </div>
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
        <div className="actions">
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
                <button
                  type="button"
                  className="btn quiet"
                  style={{ flex: "0 0 104px" }}
                  disabled={busy}
                  onClick={() => setSheet("decline")}
                >
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

function Facts({ detail, tz }: { detail: ItemDetail; tz: string | undefined }) {
  const item = detail.item;
  const rows: [string, string][] = [];
  if (item.type === "booking") {
    rows.push(["When", formatWhen(item.payload.startTime, item.payload.endTime, tz)]);
    rows.push([
      "Service",
      [item.payload.reservationFor.name, item.payload.totalPrice ? formatMoney(item.payload.totalPrice) : ""]
        .filter(Boolean)
        .join(" · "),
    ]);
    if (item.payload.partySize && item.payload.partySize > 1) rows.push(["People", String(item.payload.partySize)]);
  } else if (item.type === "order") {
    for (const l of item.payload.orderedItem.slice(0, 4)) rows.push([`${l.quantity} ×`, l.name]);
    if (item.payload.orderedItem.length > 4) rows.push(["", `and ${item.payload.orderedItem.length - 4} more`]);
    rows.push(["Total", formatMoney(item.payload.totalPrice)]);
    const d = item.payload.delivery;
    if (d)
      rows.push([
        d.method === "pickup" ? "Pick-up" : d.method === "delivery" ? "Delivery" : "Digital",
        d.when ? formatDay(d.when, tz) : "",
      ]);
  } else if (item.type === "quote_request") {
    rows.push(["For", item.payload.itemOffered.name]);
    if (item.payload.budget) rows.push(["Budget", formatMoney(item.payload.budget)]);
    if (item.payload.requestedFor) rows.push(["When", formatDay(item.payload.requestedFor, tz)]);
  } else if (item.type === "refund") {
    rows.push(["Amount", formatMoney(item.payload.amount)]);
  }
  rows.push(["Status", stateWord(item.state)]);
  return (
    <div className="facts">
      {rows.map(([k, v]) => (
        <div key={`${k}${v}`}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
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
