import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { useEffect, useId, useRef, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead } from "../components/Form";
import { type ApiProblem, problemOf } from "../lib/api";
import { countryOfZone } from "../lib/geo";
import {
  CARD_BRANDS,
  type PaymentGroup,
  paymentGroupsFor,
  paymentName,
  STRIPE_PAY_CURRENCIES,
  type StripePayChoice,
  samePayments,
  sameStripePay,
  stripePayStart,
  stripePayTo,
  togglePayment,
  toggleStripeCurrency,
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
 * Stripe Pay (ADR-045) is set below the ticks, with the business's own Stripe handle, through the same saves.
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
  // Stripe Pay as it is saved: off while it names nobody.
  const storedStripe: StripePayChoice = {
    to: data.doc.payments?.stripePay?.to ?? "",
    currencies: data.doc.payments?.stripePay?.currencies ?? [],
  };
  const [stripe, setStripe] = useState<StripePayChoice>(storedStripe);
  const [stripeProblem, setStripeProblem] = useState<string | null>(null);
  // What the owner wants, what is saved and at which version, and whether a save is on its way.
  const wanted = useRef<readonly string[]>(accepted);
  const wantedStripe = useRef<StripePayChoice>(storedStripe);
  const saved = useRef<{ list: readonly string[]; stripe: StripePayChoice; version: number }>({
    list: data.doc.payments?.accepted ?? [],
    stripe: storedStripe,
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
      for (;;) {
        const next = wanted.current;
        const nextStripe = wantedStripe.current;
        const ticks = !samePayments(next, saved.current.list);
        const byStripe = !sameStripePay(nextStripe, saved.current.stripe);
        if (!ticks && !byStripe) break;
        const clear = ticks && fromSiteRef.current;
        const res = await save.mutateAsync({
          doc: {
            payments: {
              ...(ticks ? { accepted: [...next] } : {}),
              // Off is the setting removed: its defaults (nobody, no currency) apply again.
              ...(byStripe
                ? { stripePay: nextStripe.to ? { to: nextStripe.to, currencies: [...nextStripe.currencies] } : null }
                : {}),
            },
            ...(clear ? { setup: { sources: { payments: null } } } : {}),
          },
          expected_version: saved.current.version,
        });
        saved.current = {
          list: ticks ? next : saved.current.list,
          stripe: byStripe ? nextStripe : saved.current.stripe,
          version: res.version,
        };
        if (clear) fromSiteRef.current = false;
      }
      showSaved();
    } catch (e) {
      // What is saved stands: the ticks and Stripe Pay go back to it, and the owner is told below.
      const p = problemOf(e);
      const stripeWords = p.field("payments.stripePay.to") ?? p.field("payments.stripePay.currencies");
      wanted.current = withCard(saved.current.list);
      wantedStripe.current = saved.current.stripe;
      setAccepted(wanted.current);
      setStripe(saved.current.stripe);
      if (stripeWords) setStripeProblem(stripeWords);
      else setProblem(p);
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
  /** Stripe Pay as the owner set it below: saved through the same queue as the ticks. */
  const setStripePay = (next: StripePayChoice) => {
    setProblem(null);
    setStripeProblem(null);
    wantedStripe.current = next;
    setStripe(next);
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
      <StripePay
        saved={stripe}
        currency={data.doc.business.currency}
        problem={stripeProblem}
        onSave={setStripePay}
        onProblem={setStripeProblem}
      />
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

/**
 * Stripe Pay (ADR-045): the business's own Stripe handle, and the currencies it takes there. Another business pays it
 * from its Stripe Dashboard, or its AI agent with Stripe's own tools; the money goes from Stripe account to Stripe
 * account and never through the inbox, which cannot see it. So the owner records the payment on the order, as for any
 * way paid outside the inbox. Saved only on Save, never while typing.
 */
function StripePay({
  saved,
  currency,
  problem,
  onSave,
  onProblem,
}: {
  saved: StripePayChoice;
  currency: string;
  problem: string | null;
  onSave: (next: StripePayChoice) => void;
  onProblem: (words: string | null) => void;
}) {
  const id = useId();
  const on = saved.to !== "";
  const [typed, setTyped] = useState(saved.to);
  const [currencies, setCurrencies] = useState<readonly string[]>(() =>
    saved.currencies.length ? saved.currencies : stripePayStart(currency),
  );
  // What is saved changed under the form (a save that came back, or one refused and undone): the form shows it.
  useEffect(() => {
    setTyped(saved.to);
    if (saved.currencies.length) setCurrencies(saved.currencies);
  }, [saved]);
  const to = stripePayTo(typed);
  const changed = to !== saved.to || !samePayments(currencies, saved.currencies);

  const submit = () => {
    if (!to) {
      onProblem("Type your Stripe profile handle, like @yourbusiness, or its profile id (profile_…).");
      return;
    }
    if (!currencies.length) {
      onProblem("Choose the currencies you take by Stripe Pay.");
      return;
    }
    onSave({ to, currencies });
  };

  return (
    <fieldset className="chips-field pay-stripe">
      <legend className="label">Stripe Pay</legend>
      <p className="hint">
        Other businesses on Stripe pay you to your Stripe handle, from their Dashboard or by their AI agent. In preview
        from Stripe for eligible businesses in the US and the UK, in USD, GBP and USDC: the payer needs a funded Stripe
        financial account, and you a financial account or a payout bank account on your Stripe profile.
      </p>
      <div>
        <label className="sr-only" htmlFor={id}>
          Your Stripe handle
        </label>
        <input
          id={id}
          className="input pay-stripe-input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="@yourbusiness"
          value={typed}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setTyped(e.target.value);
            onProblem(null);
          }}
        />
      </div>
      <fieldset className="pay-brands">
        <legend className="hint">In</legend>
        <div className="chips">
          {STRIPE_PAY_CURRENCIES.map((c) => (
            <label key={c} className="chip">
              <input
                type="checkbox"
                checked={currencies.includes(c)}
                onChange={(e) => {
                  setCurrencies(toggleStripeCurrency(currencies, c, e.target.checked));
                  onProblem(null);
                }}
              />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      <div className={clsx("hint", problem && "error")} role={problem ? "alert" : undefined}>
        {problem ??
          "It goes straight to your Stripe account, and this inbox cannot see it: when a payment arrives, record it on the order. Agents are told to confirm your handle, the amount and the currency first."}
      </div>
      <div className="pay-stripe-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!changed || typed.trim() === ""}
          onClick={submit}
        >
          {on ? "Save" : "Take Stripe Pay"}
        </button>
        {on && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setTyped("");
              onSave({ to: "", currencies: [] });
            }}
          >
            Stop taking Stripe Pay
          </button>
        )}
      </div>
    </fieldset>
  );
}
