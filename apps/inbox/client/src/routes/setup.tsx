import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CurrencySelect, LengthPicker, MoneyInput, Stepper, TimeZonePicker } from "../components/Choosers";
import { ConnectYourSystem } from "../components/ConnectYourSystem";
import { ErrorState } from "../components/Feedback";
import { Field, Switch } from "../components/Form";
import { HoursEditor } from "../components/Hours";
import { type ApiProblem, problemOf } from "../lib/api";
import { ensureSignedIn, session } from "../lib/auth";
import { guessCurrency } from "../lib/currencies";
import { countryOfZone, emailLangOfCountry } from "../lib/geo";
import { languageName, languagesToSave } from "../lib/languages";
import { KIND_WORDS, propertyApi, STANDARD_PLAN, useProperty } from "../lib/property";
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
  type WizardDoors,
  type WizardRoom,
  wizardDoorsDoc,
  wizardPreset,
  wizardRoomBodies,
} from "../lib/setup";
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

/** The wizard's steps by id: a kind of business that needs others (a place to stay) names its own. */
const STEPS = [
  { id: "kind", label: "Kind" },
  { id: "you", label: "You" },
  { id: "doors", label: "Agents" },
  { id: "offer", label: "Offer" },
  { id: "hours", label: "Hours" },
  { id: "answering", label: "Answering" },
] as const;
/** A place to stay (ADR-037): the place and its rooms instead of doors, offers and hours, a night's price with each. */
const STAY_STEPS = [
  { id: "kind", label: "Kind" },
  { id: "you", label: "You" },
  { id: "place", label: "Place" },
  { id: "rooms", label: "Rooms" },
  { id: "answering", label: "Answering" },
] as const;

/** The languages a place to stay writes to its guests in: guests' emails and pages ship in these six. */
const GUEST_LANGS = ["en", "es", "fr", "de", "it", "pt"] as const;
type StepId = (typeof STEPS)[number]["id"] | (typeof STAY_STEPS)[number]["id"];

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
function guessLang(zone: string): string {
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

  const [step, setStep] = useState(0);
  // What the business runs (ADR-036): it sets the rules to start from and what agents can do to begin with.
  const [kindKey, setKindKey] = useState<string | null>(null);
  const kind = kindOf(kindKey);
  const steps: readonly { readonly id: StepId; readonly label: string }[] = kind?.key === "stays" ? STAY_STEPS : STEPS;
  const at: StepId = steps[step]?.id ?? "kind";
  // A place to stay: what kind, when guests come and go, its rooms. Its id once saved, for the rooms.
  const [lodging, setLodging] = useState("guesthouse");
  const [checkIn, setCheckIn] = useState("15:00");
  const [checkOut, setCheckOut] = useState("11:00");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [town, setTown] = useState("");
  const [rooms, setRooms] = useState<WizardRoom[]>([{ id: 1, name: "", units: "1", sleeps: "2", price: "" }]);
  // Whether the place has prices once its rooms are saved: then each request is quoted in one press.
  const [priced, setPriced] = useState(false);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeError, setPlaceError] = useState<unknown>(null);
  // Run again, the wizard keeps to the place already set up rather than making a second one.
  const known = useProperty();
  const placeId = propertyId ?? known.data?.properties[0]?.id ?? null;
  // …and starts from what it says of itself, never from the defaults over it.
  const knownPlace = known.data?.setup?.property;
  const [placeRead, setPlaceRead] = useState(false);
  useEffect(() => {
    if (!knownPlace || placeRead) return;
    setPlaceRead(true);
    setLodging(knownPlace.kind);
    setCheckIn(knownPlace.checkInFrom);
    setCheckOut(knownPlace.checkOutUntil);
    setTown(knownPlace.locality ?? "");
  }, [knownPlace, placeRead]);
  const [tz] = useState(guessTimezone);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(tz);
  const [currency, setCurrency] = useState(() => guessCurrency(browserLanguages(), tz));
  const [emailLang, setEmailLang] = useState<string>(() => guessLang(tz));
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
      placeError,
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
    placeBusy;

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
      if (at === "place") {
        setPlaceError(null);
        setPlaceBusy(true);
        try {
          await saveSettings.mutateAsync({ doc: wizardDoorsDoc(doors) });
          const saved = await propertyApi.save({
            ...(placeId ? { id: placeId } : {}),
            name: name.trim(),
            kind: lodging,
            currency,
            check_in_from: checkIn,
            check_out_until: checkOut,
            town: town.trim() || null,
          });
          setPropertyId(saved.id);
        } catch (e) {
          setPlaceError(e);
          throw e;
        } finally {
          setPlaceBusy(false);
        }
      }
      if (at === "rooms" && placeId) {
        const planned = wizardRoomBodies(rooms, placeId, currency);
        if ("problem" in planned) {
          setLocal(planned.problem);
          return false;
        }
        setPlaceError(null);
        setPlaceBusy(true);
        try {
          // Each room, then a night's price for those that have one, on the place's first plan (a standard
          // one made for them when there is none): the first request is then quoted in one press.
          const rates: { room_type_id: string; nightly: number; base_guests: number }[] = [];
          for (const [i, body] of planned.bodies.entries()) {
            const made = await propertyApi.room(body);
            const nightly = planned.prices[i];
            if (nightly) {
              rates.push({ room_type_id: made.id, nightly, base_guests: (body.capacity as { total: number }).total });
            }
          }
          if (rates.length > 0) {
            const plan =
              known.data?.setup?.plans.find((x) => x.active)?.id ??
              (await propertyApi.plan({ property_id: placeId, ...STANDARD_PLAN })).id;
            await propertyApi.rates(rates.map((r) => ({ ...r, rate_plan_id: plan })));
            setPriced(true);
          }
        } catch (e) {
          setPlaceError(e);
          throw e;
        } finally {
          setPlaceBusy(false);
        }
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
    at === "hours" ||
    at === "place" ||
    (at === "rooms" && rooms.some((r) => r.name.trim())) ||
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

  if (done)
    return <Finished onOpen={leave} kind={kind} priced={priced || (known.data?.setup?.rates.length ?? 0) > 0} />;

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
            <Field
              id="su-lang"
              label={kind?.key === "stays" ? "Guests' emails are in" : "Customers' emails are in"}
              hint={langHint(kind?.key === "stays" ? GUEST_LANGS : ["en", "pt"], emailLang, kind?.key === "stays")}
            >
              <select
                id="su-lang"
                className="input"
                value={emailLang}
                onChange={(e) => {
                  setEmailLang(e.target.value);
                  setPicked((p) => ({ ...p, lang: true }));
                }}
              >
                {(kind?.key === "stays" ? GUEST_LANGS : (["en", "pt"] as const)).map((l) => (
                  <option key={l} value={l}>
                    {languageName(l)}
                  </option>
                ))}
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
                      placeholder={doors.booking ? "Initial consultation" : "Kitchen fitting"}
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

        {at === "place" && (
          <>
            <h2 className="sec">Your place</h2>
            <p className="lede small">
              What guests' assistants are told first. Prices and policies come next, in Settings.
            </p>
            <Field id="su-lodging" label="Kind of place">
              <select id="su-lodging" className="input" value={lodging} onChange={(e) => setLodging(e.target.value)}>
                {Object.entries(KIND_WORDS).map(([k, w]) => (
                  <option key={k} value={k}>
                    {w}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="su-town" label="Town" optional hint="Guests read your times by it, and agents find you by it.">
              <input
                id="su-town"
                className="input"
                autoComplete="address-level2"
                value={town}
                placeholder="Oaxaca"
                onChange={(e) => setTown(e.target.value)}
              />
            </Field>
            <div className="grid2">
              <Field id="su-in" label="Check-in from">
                <input
                  id="su-in"
                  className="input"
                  type="time"
                  step={900}
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                />
              </Field>
              <Field id="su-out" label="Check-out until">
                <input
                  id="su-out"
                  className="input"
                  type="time"
                  step={900}
                  value={checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                />
              </Field>
            </div>
            <p className="hint">
              To start, you answer each request yourself. Rooms you keep for direct guests, or your property system, can
              confirm stays on their own later.
            </p>
          </>
        )}

        {at === "rooms" && (
          <>
            <h2 className="sec">Your rooms</h2>
            <p className="lede small">
              One line per kind of room: how many you have, and how many people sleep in one. With a price a night, each
              request comes with a quote ready to send.
            </p>
            <div className="stack">
              {rooms.map((r) => (
                <div className="room-row row-glass" key={r.id}>
                  <div className="room-row-head">
                    <Field id={`su-r-${r.id}`} label="Name">
                      <input
                        id={`su-r-${r.id}`}
                        className="input"
                        value={r.name}
                        placeholder="Double room"
                        onChange={(e) =>
                          setRooms((all) => all.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))
                        }
                      />
                    </Field>
                    {rooms.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon room-row-remove"
                        aria-label={`Remove ${r.name || "this row"}`}
                        onClick={() => setRooms((all) => all.filter((x) => x.id !== r.id))}
                      >
                        <Trash2 className="icon" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div className="room-row-nums">
                    <Stepper
                      id={`su-ru-${r.id}`}
                      label="How many"
                      value={r.units}
                      min={1}
                      max={500}
                      onChange={(v) => setRooms((all) => all.map((x) => (x.id === r.id ? { ...x, units: v } : x)))}
                    />
                    <Stepper
                      id={`su-rs-${r.id}`}
                      label="Sleeps"
                      value={r.sleeps}
                      min={1}
                      max={20}
                      onChange={(v) => setRooms((all) => all.map((x) => (x.id === r.id ? { ...x, sleeps: v } : x)))}
                    />
                    <Field id={`su-rp-${r.id}`} label="A night" optional>
                      <MoneyInput
                        id={`su-rp-${r.id}`}
                        currency={currency}
                        value={r.price ?? ""}
                        placeholder="On request"
                        onChange={(v) => setRooms((all) => all.map((x) => (x.id === r.id ? { ...x, price: v } : x)))}
                      />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setRooms((all) => [...all, { id: nextId, name: "", units: "1", sleeps: "2", price: "" }]);
                setNextId((n) => n + 1);
              }}
            >
              <Plus className="icon" aria-hidden="true" />
              Add another
            </button>
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
  stays: "a place to stay",
};
const PRESET_LINES: Readonly<Partial<Record<string, string>>> = {
  appointments: "Bookings in a free slot are confirmed, and everything else waits for you.",
  trades: "Requests for a price are flagged for you, and anything urgent goes to the top.",
  shop: "Small orders are accepted and asked to pay, and large ones wait for you.",
  stays:
    "A request is quoted from your rates as a draft for you to send, and nothing is confirmed on its own until you say so.",
};

/** The end. What works now, and — just as important — what does not yet. */
function Finished({
  onOpen,
  kind,
  priced,
}: {
  onOpen: () => void;
  kind?: SetupKind | undefined;
  priced?: boolean | undefined;
}) {
  const navigate = useNavigate();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const [connecting, setConnecting] = useState(true);
  const stays = kind?.key === "stays";
  // A place to stay's one next step is its prices; where it lives is a detail for its AI.
  const where = (
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
  );
  return (
    <main className="page page-narrow setup">
      <div className="page-head">
        <h1>{stays ? "Your place is set up" : "Your inbox is answering"}</h1>
      </div>
      <section className="card glass stack">
        <p className="lede">
          {stays
            ? priced
              ? "Guests' assistants can ask for dates now, and each request comes with a quote from your prices, for you to send."
              : "Guests' assistants can ask for dates now. Add your prices so each request is quoted in one press."
            : "It takes requests now, from people and from AI agents, and answers what your rules say it may."}
        </p>
        {stays && !priced && (
          <div className="rowx">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void navigate({ to: "/settings/property", search: { tab: "Rates" } })}
            >
              Add your prices
            </button>
            <button type="button" className="btn btn-secondary" onClick={onOpen}>
              Open the inbox
            </button>
          </div>
        )}
        {stays ? (
          <details className="stack">
            <summary className="sec">Details for your AI</summary>
            {where}
          </details>
        ) : (
          <>
            <h3 className="sec">Where it lives</h3>
            {where}
          </>
        )}
        {kind && connecting && (
          <ConnectYourSystem
            groups={kind.connect}
            skip={kind.skip}
            lede="Bring in what you already use, so agents see the truth."
            onSkip={() => setConnecting(false)}
          />
        )}
        <h3 className="sec">Not set up yet</h3>
        <ul className="checks">
          {stays && !priced && (
            <li>
              <b>Prices.</b> Settings, Property, Rates: until they are there, you type a price for each request.
            </li>
          )}
          <li>
            <b>Email in.</b> So a customer can simply write to you. Settings, then the docs page on email.
          </li>
          <li>
            <b>Where events go.</b> Point your other systems at it in Settings, Integrations.
          </li>
        </ul>
        {!(stays && !priced) && (
          <div className="rowx">
            <button type="button" className="btn btn-primary" onClick={onOpen}>
              Open the inbox
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * The line under the email language: says plainly when the browser's own language is not one the emails
 * are written in yet, and which they are written in instead.
 */
function langHint(offered: readonly string[], chosen: string, stays: boolean): string | undefined {
  const browser = (typeof navigator === "undefined" ? "" : navigator.language).toLowerCase().split("-")[0] ?? "";
  if (!browser || offered.includes(browser)) return undefined;
  return `${languageName(browser)} isn't available for ${stays ? "guests" : "customers"} yet; they are written to in ${languageName(chosen)}.`;
}
