import { useEffect, useRef, useState } from "react";
import { DEFAULT_PREFS, type NotifyPrefs } from "../../../../packages/core/src/phones/prefs";
import { useApp } from "../context";
import type { PhoneAsk, PhoneRow } from "../lib/client";
import { setUpPush } from "../lib/push";
import type { QuickReply } from "../lib/replies";
import type { InboxEntry } from "../lib/session";
import { versionLine } from "../lib/update";
import { agoSentence, spamFiltersLine } from "../lib/view";
import { Nav } from "./Nav";

/** The privacy policy's part about this app. */
const PRIVACY_URL = "https://surfingdog.ai/privacy/#phone-h";

const KINDS: readonly [keyof NotifyPrefs["kinds"], string][] = [
  ["booking", "Booking and stay requests"],
  ["order", "Orders"],
  ["quote", "Quote requests"],
  ["message", "Messages"],
  ["handled", "What your rules answered"],
];

/** Times to choose quiet hours from, every half hour: picked, never typed. */
const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
);

/**
 * Settings → Notifications (the approved screen), for the inbox in front: one switch per kind, quiet
 * hours that hold notifications until morning, whether names reach the lock screen, and the phones,
 * with a test. Kept per phone, on the inbox, so each phone of a business can differ. Answers lists the
 * owner's quick replies for the inbox, kept on this phone (ADR-028 Amendment 5).
 */
export function Settings() {
  const app = useApp();
  const [prefs, setPrefs] = useState<NotifyPrefs>(app.me?.notify ?? DEFAULT_PREFS);
  const [phones, setPhones] = useState<{ phones: PhoneRow[]; this: string } | null>(null);
  const [push, setPush] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [quick, setQuick] = useState<readonly QuickReply[]>([]);
  const inboxName = app.me?.business.name || app.active?.name || "This inbox";
  const { replies } = app;
  useEffect(() => {
    let alive = true;
    replies
      ?.list()
      .then((r) => {
        if (alive) setQuick(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [replies]);
  const forget = async (r: QuickReply) => {
    if (!replies) return;
    setQuick(await replies.remove(r.id));
    setConfirmRemove(null);
  };

  useEffect(() => {
    if (app.me) setPrefs(app.me.notify);
  }, [app.me]);
  useEffect(() => {
    app.client
      ?.phones()
      .then(setPhones)
      .catch(() => undefined);
    void app.native.pushStatus().then((s) => setPush(s.available ? s.permission : "unavailable"));
  }, [app.client, app.native]);

  const save = async (next: NotifyPrefs) => {
    const before = prefs;
    setPrefs(next);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await app.client?.setNotify({ ...next, tz });
      if (r && app.me) app.setMe({ ...app.me, notify: r.notify });
    } catch (e) {
      setPrefs(before);
      app.toast(e instanceof Error ? e.message : "Not saved.");
    }
  };

  /** The spam filter's two emails: not priced, so the phone switches them as the computer does. */
  const saveEmails = async (k: "held_digest" | "weekly_summary") => {
    const spam = app.spam;
    if (!spam || !app.client) return;
    app.setSpam({ ...spam, emails: { ...spam.emails, [k]: !spam.emails[k] } });
    try {
      app.setSpam(await app.client.setSpamEmails({ [k]: !spam.emails[k] }));
    } catch (e) {
      app.setSpam(spam);
      app.toast(e instanceof Error ? e.message : "Not saved.");
    }
  };

  const test = async () => {
    try {
      const r = await app.client?.test();
      app.toast(r?.sent ? "A test is on its way." : `Not sent: ${r?.note ?? "no notifications here"}.`);
    } catch (e) {
      app.toast(e instanceof Error ? e.message : "Not sent.");
    }
  };

  const allow = async () => {
    if (!app.client || !app.active) return;
    const r = await setUpPush(app.native, app.client, app.active.alias, true, true);
    app.toast(
      r === "on"
        ? "Notifications are on."
        : r === "denied"
          ? "Allow notifications for this app in the phone's settings."
          : r === "no_build"
            ? "This version of the app can't get notifications yet."
            : r === "unavailable"
              ? `${inboxName} can't send notifications yet.`
              : "Notifications can't be set up on this phone right now.",
    );
    void app.refresh();
  };

  const remove = async (row: PhoneRow) => {
    if (!app.client) return;
    if (row.id === phones?.this) {
      await app.removeActive();
      return;
    }
    try {
      await app.client.removePhone(row.id);
      setPhones((p) => (p ? { ...p, phones: p.phones.filter((x) => x.id !== row.id) } : p));
      app.toast(`${row.name} is removed.`);
    } catch (e) {
      app.toast(e instanceof Error ? e.message : "Not removed.");
    }
    setConfirmRemove(null);
  };

  const pushOn = app.me?.phone.push === "on";
  // Why there are none, in the owner's words: this app, or this inbox.
  const noBuild = push === "unavailable";
  const noInbox = app.me !== null && !app.me.push_available;
  return (
    <div className="screen">
      <header className="head" style={{ gap: 4 }}>
        <div className="sub">{inboxName}</div>
        <h1>Notifications</h1>
      </header>
      <main className="body" style={{ gap: 18 }}>
        {!pushOn && (
          <section className="group">
            <div className="rows">
              <div>
                <span className="two">
                  <span>{noBuild || noInbox ? "Notifications aren't available" : "Notifications are off"}</span>
                  <small>
                    {app.demo
                      ? "The demo sends no notifications."
                      : noBuild
                        ? "This version of the app can't get notifications yet."
                        : noInbox
                          ? `${inboxName} can't send notifications yet.`
                          : "Allow them to hear about new requests."}
                  </small>
                </span>
                {!noBuild && !noInbox && (
                  <button type="button" className="btn link" onClick={() => void allow()}>
                    Allow
                  </button>
                )}
              </div>
            </div>
          </section>
        )}
        <section className="group" aria-labelledby="tell-h">
          <h2 id="tell-h">Tell me about</h2>
          <div className="rows">
            {KINDS.map(([k, label]) => (
              <div key={k}>
                <span>{label}</span>
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={prefs.kinds[k]}
                  aria-label={label}
                  onClick={() => void save({ ...prefs, kinds: { ...prefs.kinds, [k]: !prefs.kinds[k] } })}
                />
              </div>
            ))}
          </div>
        </section>
        <section className="group" aria-labelledby="quiet-h">
          <h2 id="quiet-h">Quiet hours</h2>
          <div className="rows">
            <div>
              <span>Hold until morning</span>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={prefs.quiet.on}
                aria-label="Hold until morning"
                onClick={() => void save({ ...prefs, quiet: { ...prefs.quiet, on: !prefs.quiet.on } })}
              />
            </div>
            {prefs.quiet.on && (
              <div>
                <span className="sub">From</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <select
                    className="time"
                    aria-label="From"
                    value={prefs.quiet.from}
                    onChange={(e) => void save({ ...prefs, quiet: { ...prefs.quiet, from: e.target.value } })}
                  >
                    {TIMES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <span className="sub">to</span>
                  <select
                    className="time"
                    aria-label="To"
                    value={prefs.quiet.to}
                    onChange={(e) => void save({ ...prefs, quiet: { ...prefs.quiet, to: e.target.value } })}
                  >
                    {TIMES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </span>
              </div>
            )}
          </div>
        </section>
        <section className="group" aria-labelledby="lock-h">
          <h2 id="lock-h">Lock screen</h2>
          <div className="rows">
            <div>
              <span className="two">
                <span>Show details</span>
                <small>Customer names and messages</small>
              </span>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={prefs.details}
                aria-label="Show details"
                onClick={() => void save({ ...prefs, details: !prefs.details })}
              />
            </div>
          </div>
        </section>
        {app.spam && (
          <section className="group" aria-labelledby="spam-h">
            <h2 id="spam-h">Spam</h2>
            <div className="rows">
              <div>
                <span className="two">
                  <small>{spamFiltersLine(app.spam.filters)}</small>
                </span>
              </div>
              {(
                [
                  ["held_digest", "A short email in the morning when something new is held"],
                  ["weekly_summary", "A summary on Mondays when something was put aside"],
                ] as const
              ).map(([k, label]) => (
                <div key={k}>
                  <span>{label}</span>
                  <button
                    type="button"
                    role="switch"
                    className="switch"
                    aria-checked={app.spam?.emails[k] ?? false}
                    aria-label={label}
                    onClick={() => void saveEmails(k)}
                  />
                </div>
              ))}
            </div>
          </section>
        )}
        {replies && (
          <section className="group" aria-labelledby="answers-h">
            <h2 id="answers-h">Answers</h2>
            <div className="rows">
              {quick.length === 0 ? (
                <div>
                  <span className="two">
                    <span>No quick replies yet</span>
                    <small>
                      After you type a reply to a message, you can save it here and send it again with one tap.
                    </small>
                  </span>
                </div>
              ) : (
                quick.map((r) => (
                  <div key={r.id}>
                    <span className="quick-text">{r.text}</span>
                    {confirmRemove === r.id ? (
                      <button
                        type="button"
                        className="btn link"
                        aria-label={`Remove “${r.text}”?`}
                        onClick={() => void forget(r)}
                      >
                        Remove it?
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn quiet sm"
                        aria-label={`Remove “${r.text}”`}
                        onClick={() => setConfirmRemove(r.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))
              )}
              <div>
                <span className="two">
                  <small>Quick replies stay on this phone, for {inboxName}. They go only when you tap one.</small>
                </span>
              </div>
            </div>
          </section>
        )}
        {phones && (
          <section className="group" aria-labelledby="dev-h">
            <h2 id="dev-h">Phones</h2>
            <div className="rows">
              {phones.phones.map((p) => (
                <div key={p.id}>
                  <span>
                    {p.name}{" "}
                    <span className="sub">
                      ·{" "}
                      {p.id === phones.this
                        ? "this phone"
                        : p.last_seen_at
                          ? `opened ${agoSentence(p.last_seen_at)}`
                          : "not opened yet"}
                    </span>
                  </span>
                  {p.id === phones.this && pushOn ? (
                    <button type="button" className="btn link" onClick={() => void test()}>
                      Send a test
                    </button>
                  ) : confirmRemove === p.id ? (
                    <button type="button" className="btn link" onClick={() => void remove(p)}>
                      Remove {p.name}?
                    </button>
                  ) : (
                    <button type="button" className="btn quiet sm" onClick={() => setConfirmRemove(p.id)}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
        <section className="group">
          <h2>{inboxName}</h2>
          <div className="rows">
            <div>
              <span className="two">
                <span>{app.active ? new URL(app.active.origin).host : ""}</span>
                <small>
                  {app.demo
                    ? "The demo: made-up examples, set up again every night."
                    : "Your inbox, on your own server or hosted by Surfing Dog."}
                </small>
              </span>
              {app.demo ? (
                <button type="button" className="btn quiet sm" onClick={app.leaveDemo}>
                  Leave the demo
                </button>
              ) : confirmRemove === "inbox" ? (
                <button type="button" className="btn link" onClick={() => void app.removeActive()}>
                  Remove {inboxName}?
                </button>
              ) : (
                <button type="button" className="btn quiet sm" onClick={() => setConfirmRemove("inbox")}>
                  Remove from this phone
                </button>
              )}
            </div>
          </div>
        </section>
        <section className="group" aria-labelledby="app-h">
          <h2 id="app-h">This app</h2>
          <div className="rows">
            <div>
              <span className="two">
                <span>
                  Version{" "}
                  {!app.appInfo
                    ? ""
                    : app.native.platform === "android"
                      ? versionLine(app.appInfo.version, app.appInfo.build)
                      : app.appInfo.version}
                </span>
                {app.update.kind !== "none" && <small>{app.update.versionName} is ready</small>}
              </span>
              {app.update.kind !== "none" && (
                <a className="btn link" href={app.update.page} rel="noopener">
                  Get it
                </a>
              )}
            </div>
            <div>
              <span>Privacy</span>
              <a className="btn link" href={PRIVACY_URL} rel="noopener">
                Read
              </a>
            </div>
          </div>
        </section>
      </main>
      <Nav current="settings" />
    </div>
  );
}

/** A day and a time, as a sentence says it ("Sat 15 Nov, 14:02"). */
function dayAndTime(at: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(at));
  } catch {
    return new Date(at).toUTCString();
  }
}

/**
 * The confirm sheet (ADR-028 Amendment 4): a new phone asked to connect to one of the inboxes on this
 * phone (named when there are several) and waits for this phone's yes. Its name is its own say, so it
 * is quoted. Confirm asks for the fingerprint or face first, and is signed by this phone's key; "Not
 * mine" removes the new phone. A phone waiting out its day ("I don't have my other phone") can only be
 * stopped from here: its owner sees no digits to compare, so there is nothing to confirm. A security
 * question, so a tap beside it never answers it: "Later" says it asks again when the app next opens.
 */
export function PhoneAskSheet({
  entry,
  ask,
  many,
  onDone,
}: {
  entry: InboxEntry;
  ask: PhoneAsk;
  /** More than one inbox is on this phone: the sheet names the one asked about. */
  many: boolean;
  onDone: () => void;
}) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const business = entry.name || "your inbox";
  const waiting = ask.wait_until ? Date.parse(ask.wait_until) : null;
  const client = app.clientFor(entry);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const was = document.activeElement;
    heading.current?.focus();
    return () => {
      if (was instanceof HTMLElement) was.focus();
    };
  }, []);

  const confirm = async () => {
    setBusy(true);
    try {
      // The yes is a person's: the fingerprint or face first, never a notification's.
      if (await app.native.canAuthenticate().catch(() => false)) {
        const ok = await app.native
          .authenticate("Confirm it's you", "To let a new phone open your inbox")
          .catch(() => false);
        if (!ok) return;
      }
      await client.confirmPhone(ask.id);
      app.toast(`"${ask.phone.name}" can open ${business} now.`);
      onDone();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : "Not confirmed.");
    } finally {
      setBusy(false);
    }
  };

  const refuse = async () => {
    setBusy(true);
    try {
      await client.refusePhone(ask.id);
      app.toast("Stopped. That phone can't open your inbox.");
      onDone();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : "Not stopped. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const title = waiting ? "A new phone connects soon" : "A new phone wants to connect";
  return (
    <>
      <div className="scrim" aria-hidden="true" />
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="phone-ask-h">
        <div className="grabber" aria-hidden="true" />
        <h2 id="phone-ask-h" ref={heading} tabIndex={-1}>
          {title}
          {many ? `: ${business}` : ""}
        </h2>
        <p className="sub" style={{ margin: 0 }}>
          A phone that calls itself <b>"{ask.phone.name}"</b> asked to connect to {business}.{" "}
          {waiting
            ? `It said you don't have this phone with you, so it is let in on ${dayAndTime(waiting)}, unless you stop it.`
            : "Confirm only if you are connecting it now, and it shows these two digits:"}
        </p>
        {!waiting && <div className="match">{ask.match}</div>}
        {waiting ? (
          <>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void refuse()}>
              Not you? Stop it
            </button>
            <button type="button" className="btn quiet" onClick={onDone}>
              It's mine, let it wait
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void confirm()}>
              Confirm
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void refuse()}>
              Not mine
            </button>
            <button type="button" className="btn quiet" disabled={busy} onClick={onDone}>
              Later
            </button>
            <p className="fine" style={{ margin: 0 }}>
              Later: it asks again when you next open the app.
            </p>
          </>
        )}
      </section>
    </>
  );
}

/**
 * This phone waits out its day for an inbox ("I don't have my other phone"): it opens nothing until
 * then, and the owner's other phones and email can stop it meanwhile.
 */
export function Waiting({ entry }: { entry: InboxEntry }) {
  const app = useApp();
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <div className="connect screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h1>Connecting on {dayAndTime(entry.waitingUntil ?? Date.now())}</h1>
        <p>
          {entry.name} lets this phone in then, unless it is stopped from one of your phones or from the email we sent
          you. Until then it opens nothing.
        </p>
        <p className="fine">
          No need to wait if you can use a computer: remove your old phone in Settings → Phone there, and sign in on
          this one again.
        </p>
      </div>
      <div className="end">
        <button type="button" className="btn" onClick={() => void app.refresh()}>
          Check again
        </button>
        {confirmRemove ? (
          <button type="button" className="btn link" onClick={() => void app.removeActive()}>
            Stop waiting for {entry.name}?
          </button>
        ) : (
          <button type="button" className="btn quiet" onClick={() => setConfirmRemove(true)}>
            Stop waiting
          </button>
        )}
      </div>
    </div>
  );
}
