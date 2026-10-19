import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Smartphone } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { api, problemOf } from "../lib/api";
import { relativeTime } from "../lib/format";
import { pushUnavailable, pushWord, qrDrawing, timeLeft } from "../lib/phones";
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
 * Settings → Phone (ADR-026): connect a phone by showing it a QR code (nothing to type), and the
 * phones that are connected, each with a test notification and a way to remove it. Only the owner,
 * signed in here, sees a code; it works once, for five minutes.
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
  const unavailable = pushUnavailable(phones.data?.push.reason ?? null);
  return (
    <>
      <ConnectCard onPaired={(p) => setNotice({ tone: "success", text: `${p.name} is connected.` })} />
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      {unavailable && <p className="hint">{unavailable}</p>}
      {phones.data && phones.data.phones.length > 0 && <PhonesCard phones={phones.data.phones} />}
    </>
  );
}

function ConnectCard({ onPaired }: { onPaired: (phone: PhoneView) => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState<{ id: string; qr: string; expires_at: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const create = useMutation({
    mutationFn: api.createPairing,
    onSuccess: (c) => {
      setNow(Date.now());
      setCode(c);
    },
  });
  const drawing = useMemo(() => (code ? qrDrawing(code.qr) : null), [code]);
  const left = code ? timeLeft(code.expires_at, now) : "";

  // The clock under the code, and whether a phone has used it: every second while it shows.
  useEffect(() => {
    if (!code) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [code]);
  const status = useQuery({
    queryKey: ["pairing", code?.id],
    queryFn: () => api.pairingStatus(code?.id ?? ""),
    enabled: code !== null && left !== "",
    refetchInterval: 2000,
  });
  // Told once per code: the answer stays cached after the code is put away.
  const told = useRef<string | null>(null);
  const tell = useRef(onPaired);
  tell.current = onPaired;
  useEffect(() => {
    if (!code || status.data?.state !== "paired" || told.current === code.id) return;
    told.current = code.id;
    setCode(null);
    void qc.invalidateQueries({ queryKey: PHONES });
    if (status.data.phone) tell.current(status.data.phone);
  }, [status.data, qc, code]);

  return (
    <section className="card glass stack">
      <SectionHead title="Your phone" />
      {!code && (
        <>
          <p className="lede small">New requests on your phone, and answer them from there. Your inbox stays here.</p>
          <div className="rowx">
            <button
              type="button"
              className="btn btn-primary"
              disabled={create.isPending}
              onClick={() => {
                create.reset();
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
      {code && drawing && (
        <div className="phone-pair">
          {left ? (
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
            <p>
              On your phone, open the Surfing Dog Inbox app and scan this. <b>Nothing to type.</b>
            </p>
            <p className="hint">
              {left ? `Works once, for ${left}.` : "Show a new one when your phone is ready."} Only someone who can see
              this screen can use it.
            </p>
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
              <div className="s">
                {[
                  `connected ${relativeTime(p.created_at)}`,
                  p.last_seen_at ? `opened ${relativeTime(p.last_seen_at)}` : null,
                  pushWord(p),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
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
