import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Smartphone } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { api, problemOf } from "../lib/api";
import { openInAppLink, phoneLine, pushUnavailable, qrDrawing, timeLeft } from "../lib/phones";
import type { PhoneView } from "../lib/types";

export const Route = createFileRoute("/settings/phone")({
  component: PhonePage,
});

const PHONES = ["phones"] as const;

interface Notice {
  readonly tone: "success" | "danger";
  readonly text: string;
}

/**
 * Settings → Phone (ADR-028): connect a phone by showing it a QR code (nothing to type), confirm it
 * here once it shows the same two digits, and the phones that are connected, each with a test
 * notification and a way to remove it. Only the owner, signed in here, sees a code; it works once, for
 * five minutes, and a phone that used it can do nothing until the owner presses Confirm.
 */
function PhonePage() {
  const phones = useQuery({ queryKey: PHONES, queryFn: api.phones, staleTime: 10_000 });
  const [notice, setNotice] = useState<Notice | null>(null);
  if (phones.error)
    return (
      <ErrorState
        title="Couldn't load your phones"
        text={problemOf(phones.error).detail}
        onRetry={() => void phones.refetch()}
      />
    );
  const unavailable = pushUnavailable(phones.data?.push.reason ?? null, phones.data?.push.hosted ?? false);
  return (
    <>
      <ConnectCard
        getApp={phones.data?.get_app ?? null}
        onNotice={setNotice}
        onPaired={(p) => setNotice({ tone: "success", text: `${p.name} is connected.` })}
      />
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      {unavailable && (
        <p className="hint">
          {unavailable.text}
          {unavailable.server && (
            <>
              <br />
              <small>{unavailable.server}</small>
            </>
          )}
        </p>
      )}
      {phones.data && phones.data.phones.length > 0 && <PhonesCard phones={phones.data.phones} />}
    </>
  );
}

/** A phone in the hand, not a computer: the code cannot be scanned by the screen showing it. */
function onAndroidPhone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const small = window.matchMedia?.("(pointer: coarse), (max-width: 560px)").matches ?? false;
  return small && /Android/i.test(navigator.userAgent);
}

function ConnectCard({
  getApp,
  onPaired,
  onNotice,
}: {
  getApp: string | null;
  onPaired: (phone: PhoneView) => void;
  onNotice: (notice: Notice | null) => void;
}) {
  const qc = useQueryClient();
  const [code, setCode] = useState<{ id: string; qr: string; expires_at: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const handHeld = useMemo(onAndroidPhone, []);
  const create = useMutation({
    mutationFn: api.createPairing,
    onSuccess: (c) => {
      setNow(Date.now());
      setCode(c);
    },
  });
  const drawing = useMemo(() => (code ? qrDrawing(code.qr) : null), [code]);
  const intent = useMemo(() => (code ? openInAppLink(code.qr) : null), [code]);
  const left = code ? timeLeft(code.expires_at, now) : "";

  // The clock under the code, and whether a phone has used it: every second while it shows.
  useEffect(() => {
    if (!code) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [code]);
  const [waitingPhone, setWaitingPhone] = useState(false);
  const status = useQuery({
    queryKey: ["pairing", code?.id],
    queryFn: () => api.pairingStatus(code?.id ?? ""),
    // A phone that used the code waits for Confirm past the code's own minutes: keep asking.
    enabled: code !== null && (left !== "" || waitingPhone),
    refetchInterval: 2000,
  });
  const asking = status.data?.state === "confirm" ? status.data : null;
  useEffect(() => setWaitingPhone(asking !== null), [asking]);

  // Told once per code: the answer stays cached after the code is put away.
  const told = useRef<string | null>(null);
  const tell = useRef(onPaired);
  tell.current = onPaired;
  const done = (phone: PhoneView | undefined) => {
    if (!code || told.current === code.id) return;
    told.current = code.id;
    setCode(null);
    void qc.invalidateQueries({ queryKey: PHONES });
    if (phone) tell.current(phone);
  };
  useEffect(() => {
    if (status.data?.state === "paired") done(status.data.phone);
  });
  const confirm = useMutation({
    mutationFn: () => api.confirmPairing(code?.id ?? ""),
    onSuccess: (r) => done(r.phone),
    onError: (e) => onNotice({ tone: "danger", text: problemOf(e).detail }),
  });
  const refuse = useMutation({
    mutationFn: () => api.refusePairing(code?.id ?? ""),
    onSuccess: () => {
      setCode(null);
      onNotice({ tone: "success", text: "That phone is removed. It never opened your inbox." });
    },
    onError: (e) => onNotice({ tone: "danger", text: problemOf(e).detail }),
  });

  return (
    <section className="card glass stack">
      <SectionHead title="Phone" />
      {!code && (
        <>
          <p className="lede small">Get new requests on your phone and answer them there. Your inbox stays here.</p>
          {getApp && (
            <p className="hint">
              First, the app on your phone:{" "}
              <a href={getApp} target="_blank" rel="noopener">
                Get it for Android
              </a>{" "}
              · iPhone soon
            </p>
          )}
          <div className="rowx">
            <button
              type="button"
              className="btn btn-primary"
              disabled={create.isPending}
              onClick={() => {
                create.reset();
                onNotice(null);
                create.mutate();
              }}
            >
              <Smartphone className="icon" aria-hidden="true" />
              Add a phone
            </button>
          </div>
          {create.error && (
            <p className="hint error" role="alert">
              {problemOf(create.error).detail}
            </p>
          )}
        </>
      )}
      {code && asking && (
        <div className="stack phone-confirm" role="alertdialog" aria-label={`${asking.phone.name} wants to connect`}>
          <p>
            <b>{asking.phone.name}</b> wants to connect · <b className="phone-match">{asking.match}</b>
          </p>
          <p className="hint">
            Your phone shows {asking.match} too? Then it's yours. If it shows another number, or you didn't scan the
            code, it isn't.
          </p>
          <div className="rowx">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={confirm.isPending || refuse.isPending}
              onClick={() => confirm.mutate()}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={confirm.isPending || refuse.isPending}
              onClick={() => refuse.mutate()}
            >
              Not mine
            </button>
          </div>
        </div>
      )}
      {code && !asking && drawing && (
        <div className="phone-pair">
          {left && handHeld && intent ? (
            <div className="stack phone-pair-text">
              <a className="btn btn-primary" href={intent}>
                <Smartphone className="icon" aria-hidden="true" />
                Open in the app
              </a>
              <p className="hint">On a computer, the code appears here.</p>
            </div>
          ) : left ? (
            <svg
              className="phone-qr"
              viewBox={`0 0 ${drawing.size} ${drawing.size}`}
              role="img"
              aria-label="A code for your phone to scan"
              shapeRendering="crispEdges"
            >
              <rect width={drawing.size} height={drawing.size} fill="#fff" />
              <path d={drawing.path} fill="#14163c" />
            </svg>
          ) : (
            <div className="phone-qr phone-qr-gone">
              <p>This code has run out.</p>
            </div>
          )}
          <div className="stack phone-pair-text">
            {!(left && handHeld && intent) && (
              <p>
                On your phone, open the Surfing Dog Inbox app and scan this. <b>Nothing to type.</b>
              </p>
            )}
            <p className="hint">
              {left ? `Works once · ${left} left. Don't share it.` : "Show a new one when your phone is ready."}
            </p>
            {getApp && (
              <p className="hint">
                No app yet?{" "}
                <a href={getApp} target="_blank" rel="noopener">
                  Get it for Android
                </a>{" "}
                · iPhone soon
              </p>
            )}
            <div className="rowx">
              {!left && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => create.mutate()}>
                  Show a new code
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCode(null)}>
                {left ? "Cancel" : "Close"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function PhonesCard({ phones }: { phones: readonly PhoneView[] }) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: api.testPhone,
    onSuccess: (r, id) => {
      const name = phones.find((p) => p.id === id)?.name ?? "The phone";
      setNotice(
        r.sent
          ? { tone: "success", text: `A test is on its way to ${name}.` }
          : { tone: "danger", text: `${name} could not be reached (${r.note}).` },
      );
      void qc.invalidateQueries({ queryKey: PHONES });
    },
    onError: (e) => setNotice({ tone: "danger", text: problemOf(e).detail }),
  });
  const remove = useMutation({
    mutationFn: api.removePhone,
    onSuccess: (_r, id) => {
      const name = phones.find((p) => p.id === id)?.name ?? "The phone";
      setNotice({ tone: "success", text: `${name} is removed. It has to be connected again to open your inbox.` });
      setActing(null);
      void qc.invalidateQueries({ queryKey: PHONES });
    },
    onError: (e) => setNotice({ tone: "danger", text: problemOf(e).detail }),
  });
  return (
    <section className="card glass stack">
      <SectionHead title="Phones" />
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      <div className="stack">
        {phones.map((p) => (
          <div key={p.id} className="catalogue-row row-glass">
            <div className="catalogue-main">
              <div className="t">
                <b>{p.name}</b>
                {p.push === "on" && <Check className="icon-xs" aria-label="Notifications on" />}
              </div>
              <div className="s">{phoneLine(p)}</div>
            </div>
            <div className="rowx">
              {p.push === "on" && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={test.isPending}
                  onClick={() => {
                    setNotice(null);
                    test.mutate(p.id);
                  }}
                >
                  Send a test
                </button>
              )}
              {acting === p.id ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(p.id)}
                >
                  Remove {p.name}?
                </button>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setActing(p.id)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
