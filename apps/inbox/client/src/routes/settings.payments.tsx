import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { type ApiProblem, problemOf } from "../lib/api";
import { countryOfZone } from "../lib/geo";
import {
  CARD_BRANDS,
  type PaymentGroup,
  paymentGroupsFor,
  paymentName,
  samePayments,
  togglePayment,
  withCard,
} from "../lib/payments";
import { qk, useSaveSettings, useSettings } from "../lib/queries";
import { sourceNote } from "../lib/sources";
import type { SettingsDoc } from "../lib/types";

export const Route = createFileRoute("/settings/payments")({
  component: PaymentsPage,
});

/** How long "Saved" stays before it fades. */
const SAVED_FOR = 2_000;

/**
 * Settings → Payments: how customers and their agents can pay the business. A press ticks a way at once; saves go
 * one at a time, each sending the latest ticks with the version the one before returned, so quick presses are never
 * lost. Published in the inbox's manifest, so an agent knows before it pays. Only the owner in person changes it.
 */
function PaymentsPage() {
  const settings = useSettings();
  const qc = useQueryClient();
  // A reload after a conflict starts the tab again from what is saved.
  const [round, setRound] = useState(0);

  if (settings.isPending) {
    return (
      <div className="card glass" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div className="card glass">
        <ErrorState
          title="Could not load the settings"
          text={problemOf(settings.error).detail}
          onRetry={() => void settings.refetch()}
        />
      </div>
    );
  }
  const reload = () => {
    void qc.invalidateQueries({ queryKey: qk.settings }).then(() => setRound((r) => r + 1));
  };
  return <PaymentsForm key={round} data={settings.data} onReload={reload} />;
}

/** The business's country, as Settings know it: its address, the country it sells under, else its time zone's. */
function countryOf(doc: SettingsDoc["doc"]): string | null {
  return doc.directory.address.addressCountry || doc.commerce.legal.country || countryOfZone(doc.business.timezone);
}

function PaymentsForm({ data, onReload }: { data: SettingsDoc; onReload: () => void }) {
  const save = useSaveSettings();
  const [accepted, setAccepted] = useState<readonly string[]>(() => withCard(data.doc.payments?.accepted ?? []));
  const [{ shown, more }] = useState(() => paymentGroupsFor(countryOf(data.doc)));
  // Open once from what is saved, then the owner's own: never folded under a finger.
  const [moreOpen] = useState(() => more.some((g) => g.tokens.some((t) => accepted.includes(t))));
  // Filled in from the website by the setup: said here until the owner leaves the tab (the line stays, so nothing
  // moves under a finger), and forgotten with the owner's first save.
  const [fromSite] = useState(() => sourceNote(data.doc.setup.sources, "payments") !== null);
  const fromSiteRef = useRef(fromSite);
  const [status, setStatus] = useState<"idle" | "saved" | "fading">("idle");
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  // What the owner wants, what is saved and at which version, and whether a save is on its way.
  const wanted = useRef<readonly string[]>(accepted);
  const saved = useRef<{ list: readonly string[]; version: number }>({
    list: data.doc.payments?.accepted ?? [],
    version: data.version,
  });
  const busy = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const showSaved = () => {
    timers.current.forEach(clearTimeout);
    setStatus("saved");
    timers.current = [
      setTimeout(() => setStatus("fading"), SAVED_FOR),
      setTimeout(() => setStatus("idle"), SAVED_FOR + 400),
    ];
  };

  const flush = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (!samePayments(wanted.current, saved.current.list)) {
        const next = wanted.current;
        const clear = fromSiteRef.current;
        const res = await save.mutateAsync({
          doc: { payments: { accepted: [...next] }, ...(clear ? { setup: { sources: { payments: null } } } : {}) },
          expected_version: saved.current.version,
        });
        saved.current = { list: next, version: res.version };
        if (clear) fromSiteRef.current = false;
      }
      showSaved();
    } catch (e) {
      // What is saved stands: the ticks go back to it, and the owner is told below.
      wanted.current = withCard(saved.current.list);
      setAccepted(wanted.current);
      setProblem(problemOf(e));
    } finally {
      busy.current = false;
    }
  };
  const pick = (token: string, on: boolean) => {
    setProblem(null);
    const next = togglePayment(wanted.current, token, on);
    wanted.current = next;
    setAccepted(next);
    void flush();
  };
  const conflict = problem?.code === "version_conflict";

  return (
    <section className="card glass stack">
      <SectionHead title="Payments">
        <span className={clsx("pay-status", status === "saved" && "is-on")} role="status" aria-live="polite">
          {status === "idle" ? "" : "Saved"}
        </span>
      </SectionHead>
      <p className="lede small">How customers can pay you. Their assistants read it before they pay.</p>
      {fromSite && <p className="hint pay-from">From your website. Untick any you don't take.</p>}
      <div className="stack pay-groups">
        {shown.map((g) => (
          <PaymentChips key={g.id} group={g} accepted={accepted} onPick={pick} />
        ))}
        <details className="details more pay-more" open={moreOpen || undefined}>
          <summary>More ways</summary>
          <div className="stack pay-groups">
            {more.map((g) => (
              <PaymentChips key={g.id} group={g} accepted={accepted} onPick={pick} />
            ))}
          </div>
        </details>
      </div>
      {problem && (
        <Toast
          tone="danger"
          text={conflict ? "Settings changed somewhere else." : "That was not saved."}
          sub={conflict ? "Reload to see the latest." : undefined}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={onReload}>
              Reload
            </button>
          }
        />
      )}
    </section>
  );
}

function Chip({ token, on, onPick }: { token: string; on: boolean; onPick: (token: string, on: boolean) => void }) {
  return (
    <label className="chip">
      <input type="checkbox" checked={on} onChange={(e) => onPick(token, e.target.checked)} />
      {paymentName(token)}
    </label>
  );
}

function PaymentChips({
  group,
  accepted,
  onPick,
}: {
  group: PaymentGroup;
  accepted: readonly string[];
  onPick: (token: string, on: boolean) => void;
}) {
  const cards = group.id === "cards";
  return (
    <fieldset className="chips-field">
      <legend className="label">{group.title}</legend>
      <div className="chips">
        {group.tokens
          .filter((t) => !(cards && CARD_BRANDS.includes(t)))
          .map((t) => (
            <Chip key={t} token={t} on={accepted.includes(t)} onPick={onPick} />
          ))}
      </div>
      {cards && accepted.includes("card") && (
        <fieldset className="pay-brands">
          <legend className="hint">Which cards?</legend>
          <div className="chips">
            {CARD_BRANDS.map((t) => (
              <Chip key={t} token={t} on={accepted.includes(t)} onPick={onPick} />
            ))}
          </div>
        </fieldset>
      )}
    </fieldset>
  );
}
