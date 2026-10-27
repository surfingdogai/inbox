import { useEffect, useState } from "react";
import { DEFAULT_PREFS, type NotifyPrefs } from "../../../../packages/core/src/phones/prefs";
import { useApp } from "../context";
import type { PhoneRow } from "../lib/client";
import { setUpPush } from "../lib/push";
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
 * with a test. Kept per phone, on the inbox, so each phone of a business can differ.
 */
export function Settings() {
  const app = useApp();
  const [prefs, setPrefs] = useState<NotifyPrefs>(app.me?.notify ?? DEFAULT_PREFS);
  const [phones, setPhones] = useState<{ phones: PhoneRow[]; this: string } | null>(null);
  const [push, setPush] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const inboxName = app.me?.business.name || app.active?.name || "This inbox";

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
                    {noBuild
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
                <small>Your inbox stays on your own website.</small>
              </span>
              {confirmRemove === "inbox" ? (
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
                <span>Version {app.appInfo ? versionLine(app.appInfo.version, app.appInfo.build) : ""}</span>
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
