import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "../components/Feedback";
import { Field, Switch } from "../components/Form";
import { HoursEditor } from "../components/Hours";
import { type ApiProblem, problemOf } from "../lib/api";
import { ensureSignedIn } from "../lib/auth";
import {
  useApplyPreset,
  useProducts,
  useProductWrite,
  useProfile,
  useSaveProfile,
  useSaveWeekly,
  useServices,
  useServiceWrite,
} from "../lib/queries";
import type { PresetKey, ServiceBody, Weekly } from "../lib/types";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ location }) => {
    if (!(await ensureSignedIn())) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: SetupWizard,
});

/** The instance is new when nobody has named the business and there is nothing to sell or book. */
export function looksUnconfigured(name: string | undefined, services: number, products: number): boolean {
  return !name?.trim() && services === 0 && products === 0;
}

/** Someone who skipped should not be asked again on every load. */
const SKIP_KEY = "surfingdog-setup-skipped";
export function setupSkipped(): boolean {
  try {
    return window.localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberSkip(): void {
  try {
    window.localStorage.setItem(SKIP_KEY, "1");
  } catch {
    // Private window. Asking again next time is the lesser evil.
  }
}

type Trade = { key: PresetKey; title: string; blurb: string; sells: "services" | "products" };

/**
 * Three ways of working, and the choice decides the rest of the wizard: what step three asks for,
 * and which rules answer for you. The words are the owner's, not the schema's — nobody thinks of
 * themselves as running a "quote_request vertical".
 */
const TRADES: readonly Trade[] = [
  {
    key: "appointments",
    title: "People book time with me",
    blurb: "A consultation, a class, a table, a treatment. You have a calendar and slots in it.",
    sells: "services",
  },
  {
    key: "trades",
    title: "People ask me for a price",
    blurb: "A job to quote, a visit to arrange. Every enquiry is different and you answer each one.",
    sells: "services",
  },
  {
    key: "shop",
    title: "People buy things from me",
    blurb: "Stock with prices. Orders come in and you fulfil them.",
    sells: "products",
  },
];

const STEPS = ["You", "What you do", "What you offer", "When you are open", "Answering"] as const;

const DEFAULT_HOURS: Weekly = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
};

/** What the browser already knows, so the first screen is not four empty boxes. */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function guessCurrency(tz: string): string {
  if (tz.startsWith("Europe/London")) return "GBP";
  if (tz.startsWith("America/")) return "USD";
  if (tz.startsWith("Europe/")) return "EUR";
  return "EUR";
}

interface Offer {
  readonly id: number;
  name: string;
  minutes: string;
  price: string;
}

function SetupWizard() {
  const navigate = useNavigate();
  const profile = useProfile();
  const services = useServices();
  const products = useProducts();

  const saveProfile = useSaveProfile();
  const serviceWrite = useServiceWrite();
  const productWrite = useProductWrite();
  const saveWeekly = useSaveWeekly();
  const applyPreset = useApplyPreset();

  const [step, setStep] = useState(0);
  const [tz] = useState(guessTimezone);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(tz);
  const [currency, setCurrency] = useState(() => guessCurrency(tz));
  const [trade, setTrade] = useState<Trade | null>(null);
  const [offers, setOffers] = useState<Offer[]>([{ id: 1, name: "", minutes: "60", price: "" }]);
  const [nextId, setNextId] = useState(2);
  const [hours, setHours] = useState<Weekly>(DEFAULT_HOURS);
  const [rules, setRules] = useState(true);
  const [done, setDone] = useState(false);

  // Whatever is in flight is the error worth showing; they never overlap.
  const problem: ApiProblem | null =
    [saveProfile.error, serviceWrite.error, productWrite.error, saveWeekly.error, applyPreset.error]
      .filter(Boolean)
      .map((e) => problemOf(e))[0] ?? null;
  const busy =
    saveProfile.isPending ||
    serviceWrite.isPending ||
    productWrite.isPending ||
    saveWeekly.isPending ||
    applyPreset.isPending;

  const existing = (services.data?.items.length ?? 0) + (products.data?.items.length ?? 0);
  const sells = trade?.sells ?? "services";

  const leave = () => {
    rememberSkip();
    void navigate({ to: "/" });
  };

  /* Each step writes as it is left, so nothing is lost if the tab closes half way. */
  const saveStep = async (): Promise<boolean> => {
    try {
      if (step === 0) {
        await saveProfile.mutateAsync({ name: name.trim(), timezone, currency, languages: ["en"] });
      }
      if (step === 2) {
        const wanted = offers.filter((o) => o.name.trim());
        for (const o of wanted) {
          if (sells === "services") {
            const body: ServiceBody = {
              name: o.name.trim(),
              duration_min: Math.max(5, Number(o.minutes) || 60),
              active: true,
              ...(o.price.trim()
                ? { price: { model: "fixed" as const, value: Math.round(Number(o.price) * 100) || 0, currency } }
                : {}),
            };
            await serviceWrite.mutateAsync({ body });
          } else {
            await productWrite.mutateAsync({
              body: {
                name: o.name.trim(),
                price: { value: Math.round(Number(o.price) * 100) || 0, currency },
                active: true,
              },
            });
          }
        }
      }
      if (step === 3 && sells === "services") {
        await saveWeekly.mutateAsync({ weekly: hours });
      }
      if (step === 4) {
        if (rules && trade) await applyPreset.mutateAsync({ key: trade.key, replace: false });
        setDone(true);
        return true;
      }
      return true;
    } catch {
      return false; // the problem is rendered from the mutation's own error
    }
  };

  const next = async () => {
    if (await saveStep()) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const canAdvance =
    (step === 0 && name.trim().length > 0) ||
    (step === 1 && trade !== null) ||
    (step === 2 && (offers.some((o) => o.name.trim()) || existing > 0)) ||
    step === 3 ||
    step === 4;

  if (profile.isError) {
    return (
      <main className="page page-narrow">
        <ErrorState
          title="Could not read this instance"
          text={problemOf(profile.error).detail}
          onRetry={() => void profile.refetch()}
        />
      </main>
    );
  }

  if (done) return <Finished onOpen={leave} />;

  return (
    <main className="page page-narrow setup">
      <div className="page-head">
        <h1>Set up your inbox</h1>
        <button type="button" className="btn btn-ghost btn-sm" onClick={leave}>
          Skip for now
        </button>
      </div>

      <ol className="steps" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={clsx("stepdot", i === step && "is-now", i < step && "is-done")}>
            <span className="n">{i < step ? <Check className="icon" aria-hidden="true" /> : i + 1}</span>
            <span className="l">{label}</span>
          </li>
        ))}
      </ol>

      <section className="card glass stack">
        {step === 0 && (
          <>
            <h2 className="sec">Who is this inbox for?</h2>
            <p className="lede small">
              The name people will see when your inbox answers them. The rest is filled in from your browser; change it
              if it is wrong.
            </p>
            <Field id="su-name" label="Business name" error={problem?.field("name")}>
              <input
                id="su-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Oficina Maré"
                autoFocus
              />
            </Field>
            <div className="grid2">
              <Field id="su-tz" label="Timezone" hint="Every time your inbox says is in this zone.">
                <input id="su-tz" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </Field>
              <Field id="su-cur" label="Currency">
                <input
                  id="su-cur"
                  className="input"
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </Field>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="sec">How do people buy from you?</h2>
            <p className="lede small">
              This decides what your inbox asks for and how it answers. You can change all of it later, and you can have
              more than one; pick the one that happens most.
            </p>
            <div className="stack">
              {TRADES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={clsx("pick row-glass", trade?.key === t.key && "is-picked")}
                  aria-pressed={trade?.key === t.key}
                  onClick={() => setTrade(t)}
                >
                  <b>{t.title}</b>
                  <span className="s">{t.blurb}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="sec">{sells === "services" ? "What can people book?" : "What do you sell?"}</h2>
            <p className="lede small">
              {sells === "services"
                ? "One is enough to start. An agent asking what you offer is answered from this."
                : "One is enough to start. If your shop publishes a product feed, connect it later in Settings and this fills itself."}
            </p>
            {existing > 0 && (
              <p className="hint">
                This instance already has {existing} {existing === 1 ? "entry" : "entries"}. Anything you add here is
                added to them.
              </p>
            )}
            <div className="stack">
              {offers.map((o, i) => (
                <div className="offer row-glass" key={o.id}>
                  <Field id={`su-o-${o.id}`} label={i === 0 ? "Name" : ""}>
                    <input
                      id={`su-o-${o.id}`}
                      className="input"
                      value={o.name}
                      placeholder={sells === "services" ? "Initial consultation" : "Whole bean, 1kg"}
                      onChange={(e) =>
                        setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))
                      }
                    />
                  </Field>
                  {sells === "services" && (
                    <Field id={`su-m-${o.id}`} label={i === 0 ? "Minutes" : ""}>
                      <input
                        id={`su-m-${o.id}`}
                        className="input"
                        inputMode="numeric"
                        value={o.minutes}
                        onChange={(e) =>
                          setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, minutes: e.target.value } : x)))
                        }
                      />
                    </Field>
                  )}
                  <Field id={`su-p-${o.id}`} label={i === 0 ? `Price (${currency})` : ""} optional={i === 0}>
                    <input
                      id={`su-p-${o.id}`}
                      className="input"
                      inputMode="decimal"
                      value={o.price}
                      placeholder="0"
                      onChange={(e) =>
                        setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, price: e.target.value } : x)))
                      }
                    />
                  </Field>
                  {offers.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`Remove ${o.name || "this row"}`}
                      onClick={() => setOffers((all) => all.filter((x) => x.id !== o.id))}
                    >
                      <Trash2 className="icon" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setOffers((all) => [...all, { id: nextId, name: "", minutes: "60", price: "" }]);
                setNextId((n) => n + 1);
              }}
            >
              <Plus className="icon" aria-hidden="true" />
              Add another
            </button>
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="sec">When are you open?</h2>
            {sells === "services" ? (
              <>
                <p className="lede small">
                  Free slots are worked out from these, so an agent is never offered a time you are closed. Weekdays
                  nine to five are filled in; change what is wrong.
                </p>
                <HoursEditor
                  initial={hours}
                  title="Opening hours"
                  hint="Days you leave closed take no bookings. Up to six windows a day, for a lunch break or an evening."
                  pending={busy}
                  error={problem}
                  onSave={(w) => setHours(w)}
                />
                <p className="hint">Saved when you continue.</p>
              </>
            ) : (
              <p className="lede small">
                You sell things rather than time, so opening hours change nothing about orders. Skip straight on. If you
                start taking bookings later, Settings has the hours.
              </p>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <h2 className="sec">What should it answer on its own?</h2>
            <p className="lede small">
              Rules are the part that saves you the work. They are yours to read and change, and nothing decides
              anything you did not write down.
            </p>
            <Switch checked={rules} onChange={setRules} disabled={busy}>
              Start from the <b>{trade?.title ?? "recommended"}</b> rules
            </Switch>
            <p className="hint">
              {trade?.key === "shop"
                ? "Small orders are accepted straight away and larger ones wait for you."
                : trade?.key === "trades"
                  ? "Quote requests are flagged for you, and anything urgent goes to the top."
                  : "Bookings in a free slot are confirmed, and everything else waits for you."}{" "}
              You can read each rule in plain English in Settings, and switch any of them off.
            </p>
          </>
        )}

        {problem && (
          <p className="hint error" role="alert">
            {problem.detail}
          </p>
        )}

        <div className="rowx wizard-nav">
          {step > 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => setStep((s) => s - 1)} disabled={busy}>
              <ArrowLeft className="icon" aria-hidden="true" />
              Back
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void next()} disabled={!canAdvance || busy}>
            {busy ? "Saving…" : step === STEPS.length - 1 ? "Finish" : "Continue"}
            {!busy && step < STEPS.length - 1 && <ArrowRight className="icon" aria-hidden="true" />}
          </button>
        </div>
      </section>
    </main>
  );
}

/** The end. What works now, and — just as important — what does not yet. */
function Finished({ onOpen }: { onOpen: () => void }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <main className="page page-narrow setup">
      <div className="page-head">
        <h1>Your inbox is answering</h1>
      </div>
      <section className="card glass stack">
        <p className="lede">
          It takes bookings, orders, quotes and messages now, from people and from AI agents, and answers what your
          rules say it may.
        </p>
        <h3 className="sec">Where it lives</h3>
        <dl className="fields">
          <div>
            <dt>Agents discover you at</dt>
            <dd className="mono">{origin}/.well-known/agent-inbox.json</dd>
          </div>
          <div>
            <dt>Their tools are at</dt>
            <dd className="mono">{origin}/mcp</dd>
          </div>
          <div>
            <dt>Your own AI connects to</dt>
            <dd className="mono">{origin}/mcp/owner</dd>
          </div>
        </dl>
        <h3 className="sec">Not set up yet</h3>
        <ul className="checks">
          <li>
            <b>Email in.</b> So a customer can simply write to you. Settings, then the docs page on email.
          </li>
          <li>
            <b>Where events go.</b> Point your other systems at it in Settings, Integrations.
          </li>
          <li>
            <b>A product feed,</b> if your shop publishes one. It fills your catalogue by itself.
          </li>
        </ul>
        <div className="rowx">
          <button type="button" className="btn btn-primary" onClick={onOpen}>
            Open the inbox
          </button>
        </div>
      </section>
    </main>
  );
}
