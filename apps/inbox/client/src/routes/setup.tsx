import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CurrencySelect, LengthPicker, MoneyInput, TimeZonePicker } from "../components/Choosers";
import { ConnectYourSystem } from "../components/ConnectYourSystem";
import { ErrorState } from "../components/Feedback";
import { Field, Switch } from "../components/Form";
import { HoursEditor } from "../components/Hours";
import { type ApiProblem, problemOf } from "../lib/api";
import { ensureSignedIn, session } from "../lib/auth";
import { guessCurrency } from "../lib/currencies";
import { countryOfZone, emailLangOfCountry } from "../lib/geo";
import { languageName, languagesToSave } from "../lib/languages";
import {
  useApplyPreset,
  useNetworks,
  useProducts,
  useProductWrite,
  useProfile,
  useSaveProfile,
  useSaveSettings,
  useSaveWeekly,
  useServices,
  useServiceWrite,
  useSettings,
} from "../lib/queries";
import {
  joinNetworkDoc,
  KINDS,
  kindOf,
  networkOffer,
  offerBodies,
  ownerEmailDoc,
  SETUP_NETWORK,
  type SetupKind,
  staffBodies,
  type WizardDoors,
  type WizardStep,
  withOffered,
  wizardDoorsDoc,
  wizardPreset,
  wizardSteps,
} from "../lib/setup";
import { useStaff, useStaffWrite } from "../lib/staff";
import type { Weekly } from "../lib/types";

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

/**
 * What agents can do, the same three switches as Settings: more than one, as most businesses take
 * bookings and requests for a price and messages. The choice decides the rest of the wizard: whether
 * step three asks for a length, whether it asks for hours, and which rules answer for you.
 */
const DOORS: readonly { readonly key: keyof WizardDoors; readonly label: string; readonly line: string }[] = [
  { key: "booking", label: "Agents can book time", line: "A consultation, a class, a table, a treatment." },
  { key: "quoteRequest", label: "Agents can ask for a price", line: "A job to quote, a visit to arrange." },
  { key: "message", label: "Agents can send a message", line: "Anything else, for you to answer." },
];

/** The wizard's steps by id (`wizardSteps`): a salon is asked who works here too. */
type StepId = WizardStep["id"];

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

/**
 * The customers' email language to start from: the one of the country the time zone is in (Lisbon,
 * São Paulo: Portuguese), else the browser's, else English.
 */
function guessLang(zone: string): "en" | "pt" {
  const byPlace = emailLangOfCountry(countryOfZone(zone));
  if (byPlace) return byPlace;
  try {
    return navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en";
  } catch {
    return "en";
  }
}

const browserLanguages = (): string[] =>
  typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];

interface Offer {
  readonly id: number;
  name: string;
  minutes: string;
  price: string;
}

/**
 * Someone a salon names at setup, with the services they give; `picked` once the owner chose those
 * (until then they give every service offered), `saved` once they are kept.
 */
interface Person {
  readonly id: number;
  name: string;
  services: readonly string[];
  picked?: boolean;
  saved?: string;
}

function SetupWizard() {
  const navigate = useNavigate();
  const profile = useProfile();
  const services = useServices();
  const products = useProducts();

  const settings = useSettings();
  // Where requests are announced is the host's to hold on an inbox it runs: not asked here then.
  const ownerEmailHeld = (settings.data?.locked ?? []).some(
    (l) => l === "notifications" || l === "notifications.ownerEmail",
  );
  const saveProfile = useSaveProfile();
  const saveSettings = useSaveSettings();
  const serviceWrite = useServiceWrite();
  const productWrite = useProductWrite();
  const saveWeekly = useSaveWeekly();
  const applyPreset = useApplyPreset();
  const staffWrite = useStaffWrite();

  const [step, setStep] = useState(0);
  // What the business runs (ADR-032): it sets the rules to start from and what agents can do to begin with.
  const [kindKey, setKindKey] = useState<string | null>(null);
  const kind = kindOf(kindKey);
  const steps = wizardSteps(kind);
  const at: StepId = steps[step]?.id ?? "kind";
  // Who works here (ADR-035, a salon): one name each, the services they give.
  const [people, setPeople] = useState<Person[]>([{ id: 1, name: "", services: [] }]);
  const [nextPerson, setNextPerson] = useState(2);
  const [tz] = useState(guessTimezone);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(tz);
  const [currency, setCurrency] = useState(() => guessCurrency(browserLanguages(), tz));
  const [emailLang, setEmailLang] = useState<"en" | "pt">(() => guessLang(tz));
  // Until the owner picks them, the currency and the email language follow the time zone's country.
  const [picked, setPicked] = useState({ currency: false, lang: false });
  const pickZone = (zone: string) => {
    setTimezone(zone);
    if (!picked.currency) setCurrency(guessCurrency(browserLanguages(), zone));
    if (!picked.lang) setEmailLang(guessLang(zone));
  };
  // Where new requests are announced: the address they signed in with, unless they say otherwise.
  const [ownerEmail, setOwnerEmail] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void session().then((u) => {
      if (live && u?.email) setOwnerEmail((typed) => typed || u.email);
    });
    return () => {
      live = false;
    };
  }, []);
  // A business the inbox already knows by name (a plan, an earlier visit) starts with it.
  useEffect(() => {
    const known = profile.data?.name?.trim();
    if (known) setName((typed) => typed || known);
  }, [profile.data?.name]);
  const [doors, setDoors] = useState<WizardDoors>({ booking: true, quoteRequest: true, message: true });
  const [offers, setOffers] = useState<Offer[]>([{ id: 1, name: "", minutes: "60", price: "" }]);
  const [nextId, setNextId] = useState(2);
  const [hours, setHours] = useState<Weekly>(DEFAULT_HOURS);
  const [rules, setRules] = useState(true);
  // On unless the owner says no: the business is listed where agents search, and its record starts.
  const [join, setJoin] = useState(true);
  // A first setup is one that found nothing set up when it opened: run again, it leaves the network
  // to Settings → Networks, where the owner already chose.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  useEffect(() => {
    if (firstRun !== null || !profile.data || !services.data || !products.data) return;
    setFirstRun(looksUnconfigured(profile.data.name, services.data.items.length, products.data.items.length));
  }, [firstRun, profile.data, services.data, products.data]);
  const networks = useNetworks();
  const offer =
    settings.data && networks.data && firstRun !== null
      ? networkOffer(settings.data, { firstRun, reportable: networks.data.reportable === true })
      : null;
  const [done, setDone] = useState(false);

  // Whatever is in flight is the error worth showing; they never overlap.
  const problem: ApiProblem | null =
    [
      saveProfile.error,
      saveSettings.error,
      serviceWrite.error,
      productWrite.error,
      saveWeekly.error,
      applyPreset.error,
      staffWrite.error,
    ]
      .filter(Boolean)
      .map((e) => problemOf(e))[0] ?? null;
  const busy =
    saveProfile.isPending ||
    saveSettings.isPending ||
    serviceWrite.isPending ||
    productWrite.isPending ||
    saveWeekly.isPending ||
    applyPreset.isPending ||
    staffWrite.isPending;
  const offered = (services.data?.items ?? []).filter((s) => s.active === 1);
  // Who works here: each person gives every service offered, as the list of them arrives, until the owner
  // picks theirs.
  const offeredIds = offered.map((s) => s.id).join(",");
  useEffect(() => {
    if (at !== "staff" || !offeredIds) return;
    setPeople((ps) => withOffered(ps, offeredIds.split(",")));
  }, [at, offeredIds]);

  const existing = (services.data?.items.length ?? 0) + (products.data?.items.length ?? 0);
  // Booked at a time, or only asked about for a price.
  const asked = !doors.booking;
  const preset = wizardPreset(doors, kind);

  const leave = () => {
    rememberSkip();
    void navigate({ to: "/" });
  };

  /* Each step writes as it is left, so nothing is lost if the tab closes half way. */
  const saveStep = async (): Promise<boolean> => {
    setLocal(null);
    try {
      if (at === "you") {
        // A business already named keeps the languages it has, the email language first; a new one starts with it.
        const known = profile.data?.name?.trim() ? (profile.data.languages ?? []) : [];
        await saveProfile.mutateAsync({
          name: name.trim(),
          timezone,
          currency,
          languages: languagesToSave(known, emailLang, true),
        });
        // A merge: only this one key is sent, everything else in the settings stays as it is.
        if (!ownerEmailHeld) await saveSettings.mutateAsync({ doc: ownerEmailDoc(ownerEmail) });
      }
      if (at === "doors") {
        await saveSettings.mutateAsync({ doc: wizardDoorsDoc(doors) });
      }
      if (at === "offer") {
        const planned = offerBodies(offers, "services", currency, asked);
        if ("problem" in planned) {
          setLocal(planned.problem);
          return false;
        }
        if (planned.kind === "services") {
          for (const body of planned.bodies) await serviceWrite.mutateAsync({ body });
        } else {
          for (const body of planned.bodies) await productWrite.mutateAsync({ body });
        }
      }
      if (at === "staff") {
        // Kept once each: back and on again updates who was kept, never adds them twice.
        const bodies = staffBodies(people);
        const named = people.filter((p) => p.name.trim());
        const kept: Person[] = [];
        for (const [i, body] of bodies.entries()) {
          const p = named[i] as Person;
          const view = await staffWrite.mutateAsync(p.saved ? { id: p.saved, body } : { body });
          kept.push({ ...p, saved: view.id });
        }
        setPeople((all) => all.map((p) => kept.find((k) => k.id === p.id) ?? p));
      }
      if (at === "hours" && doors.booking) {
        await saveWeekly.mutateAsync({ weekly: hours });
      }
      if (at === "answering") {
        if (rules && preset) await applyPreset.mutateAsync({ key: preset, replace: false });
        // A merge of the one key: only the owner in person switches a network on, and this is them.
        if (join && offer === "switch") await saveSettings.mutateAsync({ doc: joinNetworkDoc() });
        setDone(true);
        return true;
      }
      return true;
    } catch {
      return false; // the problem is rendered from the mutation's own error
    }
  };

  const next = async () => {
    if (await saveStep()) setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  const canAdvance =
    at === "kind" ||
    (at === "you" && name.trim().length > 0) ||
    (at === "doors" && (doors.booking || doors.quoteRequest || doors.message)) ||
    (at === "offer" && (!doors.booking || offers.some((o) => o.name.trim()) || existing > 0)) ||
    at === "staff" ||
    at === "hours" ||
    at === "answering";

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

  if (done) return <Finished onOpen={leave} kind={kind} />;

  return (
    <main className="page page-narrow setup">
      <div className="page-head">
        <h1>Set up your inbox</h1>
        <button type="button" className="btn btn-ghost btn-sm" onClick={leave}>
          Skip for now
        </button>
      </div>

      <ol className="steps" aria-label="Setup steps">
        {steps.map(({ id, label }, i) => (
          <li key={id} className={clsx("stepdot", i === step && "is-now", i < step && "is-done")}>
            <span className="n">{i < step ? <Check className="icon" aria-hidden="true" /> : i + 1}</span>
            <span className="l">{label}</span>
          </li>
        ))}
      </ol>

      <section className="card glass stack">
        {at === "kind" && (
          <fieldset className="chips-field stack">
            <legend>
              <h2 className="sec">What do you run?</h2>
            </legend>
            <div className="chips" role="radiogroup">
              {KINDS.map((k) => (
                <label key={k.key} className="chip">
                  <input
                    type="radio"
                    name="su-kind"
                    checked={kindKey === k.key}
                    onChange={() => {
                      setKindKey(k.key);
                      setDoors(k.doors);
                    }}
                  />
                  <span>{k.label}</span>
                </label>
              ))}
            </div>
            <p className="hint">{kind ? kind.line : "Pick the nearest. You can change everything later."}</p>
          </fieldset>
        )}

        {at === "you" && (
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
                placeholder="Maple & Fade"
              />
            </Field>
            <div className="grid2">
              <Field id="su-tz" label="Time zone" hint="Hours and bookings use this time zone.">
                <TimeZonePicker id="su-tz" value={timezone} onChange={pickZone} />
              </Field>
              <Field id="su-cur" label="Currency" error={problem?.field("currency")}>
                <CurrencySelect
                  id="su-cur"
                  value={currency}
                  onChange={(c) => {
                    setCurrency(c);
                    setPicked((p) => ({ ...p, currency: true }));
                  }}
                />
              </Field>
            </div>
            {!ownerEmailHeld && (
              <Field
                id="su-owner"
                label="Where should we tell you about new requests?"
                hint="An email address. Empty, we write to the address you sign in with."
                error={problem?.field("notifications.ownerEmail")}
              >
                <input
                  id="su-owner"
                  className="input"
                  type="email"
                  autoComplete="email"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </Field>
            )}
            <Field id="su-lang" label="Customers' emails are in">
              <select
                id="su-lang"
                className="input"
                value={emailLang}
                onChange={(e) => {
                  setEmailLang(e.target.value === "pt" ? "pt" : "en");
                  setPicked((p) => ({ ...p, lang: true }));
                }}
              >
                <option value="en">{languageName("en")}</option>
                <option value="pt">{languageName("pt")}</option>
              </select>
            </Field>
          </>
        )}

        {at === "doors" && (
          <>
            <h2 className="sec">What can agents do?</h2>
            <p className="lede small">As many as you like. You can change them any time in Settings.</p>
            <ul className="door-list">
              {DOORS.map((d) => (
                <li key={d.key} className="door-row">
                  <Switch checked={doors[d.key]} onChange={(on) => setDoors((all) => ({ ...all, [d.key]: on }))}>
                    {d.label}
                  </Switch>
                  <span className="door-note">{d.line}</span>
                </li>
              ))}
            </ul>
            {!doors.booking && !doors.quoteRequest && !doors.message && (
              <p className="hint">Agents can't reach you at all.</p>
            )}
          </>
        )}

        {at === "offer" && (
          <>
            <h2 className="sec">{doors.booking ? "What can people book?" : "What can people ask you about?"}</h2>
            <p className="lede small">
              {doors.booking
                ? "One is enough to start. An agent asking what you offer is answered from this."
                : "Optional: agents can ask for a price in their own words. Name what you do and they ask about it."}
            </p>
            {existing > 0 && (
              <p className="hint">
                This instance already has {existing} {existing === 1 ? "entry" : "entries"}. Anything you add here is
                added to them.
              </p>
            )}
            <div className="stack">
              {offers.map((o) => (
                <div className="offer row-glass" key={o.id}>
                  <Field id={`su-o-${o.id}`} label="Name">
                    <input
                      id={`su-o-${o.id}`}
                      className="input"
                      value={o.name}
                      placeholder={
                        kind?.key === "salon"
                          ? "Cut & blow-dry"
                          : doors.booking
                            ? "Initial consultation"
                            : "Kitchen fitting"
                      }
                      onChange={(e) =>
                        setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))
                      }
                    />
                  </Field>
                  {doors.booking && (
                    <Field id={`su-p-${o.id}`} label="Price" optional>
                      <MoneyInput
                        id={`su-p-${o.id}`}
                        currency={currency}
                        value={o.price}
                        placeholder="On request"
                        onChange={(v) => setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, price: v } : x)))}
                      />
                    </Field>
                  )}
                  {doors.booking && (
                    <div className="wide">
                      <LengthPicker
                        legend="Length"
                        value={o.minutes}
                        onChange={(v) => setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, minutes: v } : x)))}
                      />
                    </div>
                  )}
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

        {at === "staff" && (
          <>
            <h2 className="sec">Who works here?</h2>
            <p className="lede small">
              The people clients book by name, and what each gives. Clients see a first name. Their own prices, hours
              and photos are in Settings, under Staff.
            </p>
            <div className="stack">
              {people.map((p) => (
                <div className="offer person row-glass" key={p.id}>
                  <Field id={`su-s-${p.id}`} label="Name">
                    <input
                      id={`su-s-${p.id}`}
                      className="input"
                      value={p.name}
                      placeholder="Mei Chen"
                      onChange={(e) =>
                        setPeople((all) => all.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))
                      }
                    />
                  </Field>
                  {people.length > 1 && !p.saved && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`Remove ${p.name || "this person"}`}
                      onClick={() => setPeople((all) => all.filter((x) => x.id !== p.id))}
                    >
                      <Trash2 className="icon" aria-hidden="true" />
                    </button>
                  )}
                  {offered.length > 0 && (
                    <fieldset className="chips-field wide">
                      <legend className="label">Services</legend>
                      <div className="chips">
                        {offered.map((svc) => {
                          const on = p.services.includes(svc.id);
                          return (
                            <button
                              key={svc.id}
                              type="button"
                              className="chip chip-toggle"
                              aria-pressed={on}
                              onClick={() =>
                                setPeople((all) =>
                                  all.map((x) =>
                                    x.id === p.id
                                      ? {
                                          ...x,
                                          picked: true,
                                          services: on
                                            ? x.services.filter((s) => s !== svc.id)
                                            : [...x.services, svc.id],
                                        }
                                      : x,
                                  ),
                                )
                              }
                            >
                              {svc.name}
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setPeople((all) => [...all, { id: nextPerson, name: "", services: offered.map((s) => s.id) }]);
                setNextPerson((n) => n + 1);
              }}
            >
              <Plus className="icon" aria-hidden="true" />
              Add someone
            </button>
            <p className="hint">Optional: with nobody named, bookings are taken for the salon as a whole.</p>
          </>
        )}

        {at === "hours" && (
          <>
            <h2 className="sec">When are you open?</h2>
            {doors.booking ? (
              <>
                <p className="lede small">Agents are offered free times inside these, never when you are closed.</p>
                <HoursEditor
                  initial={hours}
                  title="Opening hours"
                  hint="Days left closed take no bookings."
                  pending={busy}
                  error={problem}
                  onChange={(w) => setHours(w)}
                />
                <p className="hint">Saved when you continue.</p>
              </>
            ) : (
              <p className="lede small">
                You take no bookings here, so hours change nothing yet. Settings has them when you do.
              </p>
            )}
          </>
        )}

        {at === "answering" && (
          <>
            <h2 className="sec">What should it answer on its own?</h2>
            <p className="lede small">
              Rules are the part that saves you the work. They are yours to read and change, and nothing decides
              anything you did not write down.
            </p>
            {preset ? (
              <>
                <Switch checked={rules} onChange={setRules} disabled={busy}>
                  Start from the rules for {PRESET_WORDS[preset] ?? "your kind of business"}
                </Switch>
                <p className="hint">
                  {PRESET_LINES[preset] ?? "Everything waits for you."} Each rule reads in plain words in Settings, and
                  switches off.
                </p>
              </>
            ) : (
              <p className="hint">Messages come to you; nothing answers on its own.</p>
            )}
            {offer && (
              <div className="setup-network">
                <h3 className="sec">Be found</h3>
                {offer === "switch" ? (
                  <>
                    <Switch checked={join} onChange={setJoin} disabled={busy}>
                      List your business on {SETUP_NETWORK.replace(/^https:\/\//, "")}
                    </Switch>
                    <p className="hint">
                      It lists you where AI agents search and keeps your track record. Off any time, in Settings.
                    </p>
                  </>
                ) : (
                  <p className="hint">Once your inbox has a public https address, list it in Settings → Networks.</p>
                )}
              </div>
            )}
          </>
        )}

        {(local || problem) && (
          <p className="hint error" role="alert">
            {local ?? problem?.detail}
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
            {busy ? "Saving…" : step === steps.length - 1 ? "Finish" : "Continue"}
            {!busy && step < steps.length - 1 && <ArrowRight className="icon" aria-hidden="true" />}
          </button>
        </div>
      </section>
    </main>
  );
}

/** How the last step names a preset's rules, and what they do, in a line each. */
const PRESET_WORDS: Readonly<Partial<Record<string, string>>> = {
  appointments: "bookings",
  trades: "requests for a price",
  shop: "orders",
  salon: "salons and barbers",
};
const PRESET_LINES: Readonly<Partial<Record<string, string>>> = {
  appointments: "Bookings in a free slot are confirmed, and everything else waits for you.",
  trades: "Requests for a price are flagged for you, and anything urgent goes to the top.",
  shop: "Small orders are accepted and asked to pay, and large ones wait for you.",
  salon: "A returning client is confirmed when their stylist is free; a first visit, and anything else, waits for you.",
};

/** The end. What works now, and — just as important — what does not yet. */
function Finished({ onOpen, kind }: { onOpen: () => void; kind?: SetupKind | undefined }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const [connecting, setConnecting] = useState(true);
  // A salon with nobody named yet: who people book by name is still to add.
  const staff = useStaff();
  const nobody = kind?.key === "salon" && staff.isSuccess && staff.data.items.length === 0;
  return (
    <main className="page page-narrow setup">
      <div className="page-head">
        <h1>Your inbox is answering</h1>
      </div>
      <section className="card glass stack">
        <p className="lede">
          It takes requests now, from people and from AI agents, and answers what your rules say it may.
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
        {kind && connecting && (
          <ConnectYourSystem
            groups={kind.connect}
            lede="Bring in what you already use, so agents see the truth."
            onSkip={() => setConnecting(false)}
          />
        )}
        <h3 className="sec">Not set up yet</h3>
        <ul className="checks">
          {nobody && (
            <li>
              <b>Your staff.</b> Who people book by name: <a href="/settings/services?tab=staff">Settings, Staff</a>.
            </li>
          )}
          <li>
            <b>Email in.</b> So a customer can simply write to you. Settings, then the docs page on email.
          </li>
          <li>
            <b>Where events go.</b> Point your other systems at it in Settings, Integrations.
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
