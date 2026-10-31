import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { BringFrom } from "../components/BringFrom";
import {
  CurrencySelect,
  LanguagePicker,
  LengthPicker,
  MoneyInput,
  OtherCurrencies,
  Stepper,
  TimeZonePicker,
} from "../components/Choosers";
import { ConnectYourSystem } from "../components/ConnectYourSystem";
import { ErrorState } from "../components/Feedback";
import { Field, Switch } from "../components/Form";
import { HoursEditor } from "../components/Hours";
import { KindPicker } from "../components/KindPicker";
import { Chips } from "../components/Property";
import { WhereYouWork } from "../components/WhereYouWork";
import { type ApiProblem, problemOf } from "../lib/api";
import { ensureSignedIn, session } from "../lib/auth";
import { SOURCE_CARDS, SYNC_CARDS } from "../lib/bring";
import { guessCurrency } from "../lib/currencies";
import { durationWords } from "../lib/durations";
import { EMPTY_MENU, foodApi } from "../lib/food";
import { countryOfZone, emailLangOfCountry } from "../lib/geo";
import { type BusinessKind, type ChosenKind, chosenKind, settleTyped } from "../lib/kinds";
import { languageName, languagesToSave } from "../lib/languages";
import { paymentName, setupPayments, togglePayment } from "../lib/payments";
import { KIND_WORDS, propertyApi, STANDARD_PLAN, useProperty } from "../lib/property";
import {
  qk,
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
  anyDoor,
  bringable,
  DISCOUNT_CHOICES,
  DISH_PLACEHOLDERS,
  DISH_SECTIONS,
  type DishDraft,
  DOOR_GROUPS,
  defaultDoors,
  discountLine,
  dishPlan,
  doorRows,
  doorsStepDoc,
  GENERAL,
  isKitchen,
  joinNetworkDoc,
  KINDS,
  kindOf,
  networkOffer,
  type OfferMode,
  type OfferSection,
  offerBodies,
  offerModeFor,
  offerSections,
  ownerEmailDoc,
  quickKind,
  SETUP_NETWORK,
  type SetupKind,
  type StepId,
  savedDoors,
  setupKeyOfSaved,
  setupKindOf,
  startDoors,
  stepsFor,
  termsOf,
  type WizardDoors,
  type WizardRoom,
  type WizardTerms,
  withListed,
  wizardPreset,
  wizardRoomBodies,
} from "../lib/setup";
import { type AreaDraft, areaDocOf, areaReady, emptyArea, useWork } from "../lib/trades";
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

/** The languages a place to stay writes to its guests in: guests' emails and pages ship in these six. */
const GUEST_LANGS = ["en", "es", "fr", "de", "it", "pt"] as const;

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

/**
 * The languages to start from: the time zone's country's and the browser's own, each once. Portuguese where it is
 * the country's goes first: the inbox writes in it when a customer's own is neither English nor Portuguese.
 */
function startLangs(zone: string): string[] {
  const guess = guessLang(zone);
  let own = "";
  try {
    own = (navigator.language ?? "").toLowerCase().split("-")[0] ?? "";
  } catch {
    own = "";
  }
  const list = guess === "pt" ? [guess, own] : [own, guess];
  return [...new Set(list.filter((l) => /^[a-z]{2,3}$/.test(l)))];
}

interface Offer {
  readonly id: number;
  name: string;
  minutes: string;
  price: string;
}

interface Dish extends DishDraft {
  readonly id: number;
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

  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  // What the business runs (ADR-036): it sets the rules to start from and what agents can do to begin with.
  const [kindKey, setKindKey] = useState<string | null>(null);
  const kind = kindOf(kindKey);
  // …and exactly what it is, from the list of hundreds or in the owner's own words (`directory.kind`): saved only
  // once the owner chose, so running the wizard again changes nothing they did not touch.
  const [bizKind, setBizKind] = useState<ChosenKind | null>(null);
  const [kindText, setKindText] = useState("");
  const [kindTouched, setKindTouched] = useState(false);
  // The setup the saved kind reads as, run again: a kind's starting settings are written only for another one.
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const steps = stepsFor(kindKey);
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
  const work = useWork();
  const [area, setArea] = useState<AreaDraft>(() => emptyArea(countryOfZone(tz) ?? ""));
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(tz);
  const [currency, setCurrency] = useState(() => guessCurrency(browserLanguages(), tz));
  // The currencies taken besides it (`payments.currencies`): prices stay in the business's own.
  const [others, setOthers] = useState<readonly string[]>([]);
  const [moreCurrencies, setMoreCurrencies] = useState(false);
  // The languages the business speaks, its order kept: customers write in any of them.
  const [langs, setLangs] = useState<readonly string[]>(() => startLangs(tz));
  // Until the owner picks them, the currency and the languages follow the time zone's country.
  const [picked, setPicked] = useState({ currency: false, lang: false });
  const pickZone = (zone: string) => {
    setTimezone(zone);
    if (!picked.currency) setCurrency(guessCurrency(browserLanguages(), zone));
    if (!picked.lang) setLangs(startLangs(zone));
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
  // A business the inbox already knows by name (a plan, an earlier visit) starts with it, its currency and its
  // languages: the wizard run again never guesses over what the owner said.
  const [profileRead, setProfileRead] = useState(false);
  useEffect(() => {
    const known = profile.data?.name?.trim();
    if (!known || profileRead || !profile.data) return;
    setProfileRead(true);
    setName((typed) => typed || known);
    setCurrency(profile.data.currency);
    if (profile.data.languages.length) setLangs(profile.data.languages);
    setPicked({ currency: true, lang: true });
  }, [profile.data, profileRead]);
  const [chosenDoors, setDoors] = useState<WizardDoors>(() => defaultDoors(undefined));
  // With a product listed, ordering is open whatever was chosen: the doors are shown and saved beside it.
  const listed = (products.data?.items ?? []).filter((p) => p.active).length;
  const doors = withListed(chosenDoors, kind, listed);
  // The limits beside the doors, from what Settings say: how long before it can be cancelled, a discount, how paid.
  const [terms, setTerms] = useState<WizardTerms>(() => termsOf(undefined));
  const [settingsRead, setSettingsRead] = useState(false);
  useEffect(() => {
    if (settingsRead || !settings.data) return;
    setSettingsRead(true);
    const doc = settings.data.doc;
    setTerms(termsOf(doc));
    setOthers(doc.payments.currencies ?? []);
    // Run again, it starts from what the business said it runs, and every door as Settings have it.
    const saved = doc.directory.kind;
    const key = setupKeyOfSaved(saved);
    if (saved && key && !kindTouched) {
      setBizKind(saved);
      setKindText(saved.label);
      setKindKey(key);
      setSavedKey(key);
      setDoors(savedDoors(kindOf(key), doc));
    } else if (!kindTouched) {
      setDoors(savedDoors(undefined, doc));
    }
  }, [settings.data, settingsRead, kindTouched]);
  const [offers, setOffers] = useState<Offer[]>([{ id: 1, name: "", minutes: "60", price: "" }]);
  // Products to start a shop's catalogue with: a name and a price each.
  const [goods, setGoods] = useState<Offer[]>([{ id: 1, name: "", minutes: "0", price: "" }]);
  // How the offer and the rooms are answered: a few now, from the system the business uses, or later.
  const [offerMode, setOfferMode] = useState<OfferMode>("now");
  // The calendars and booking tools that keep a service's times in step, opened on request.
  const [syncOpen, setSyncOpen] = useState(false);
  const [roomsMode, setRoomsMode] = useState<OfferMode>("now");
  const [nextId, setNextId] = useState(2);
  // A kitchen's first dishes (ADR-040): on the menu in a section, their allergens for Settings → Menu.
  const kitchen = isKitchen(kind);
  const sectionChoices = DISH_SECTIONS[kind?.key ?? ""] ?? ["Menu"];
  const [dishes, setDishes] = useState<Dish[]>([{ id: 1, name: "", price: "", section: "" }]);
  const [dishesMade, setDishesMade] = useState(0);
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
  const sections = offerSections(doors, kind);
  // Bringing them falls back to adding them when nothing asked for can be brought (services are named here).
  const offerHow = offerModeFor(offerMode, sections);
  const country = countryOfZone(timezone);

  /* What the business runs: a quick pick, a kind of the list, or its own words. */
  // Another setup starts from its own doors; the same one (another kind of it) keeps the doors as they are.
  const startFrom = (setup: SetupKind) => {
    if (setup.key !== kindKey) setDoors(startDoors(setup, settings.data?.doc));
  };
  const pickQuick = (key: string) => {
    const setup = kindOf(key);
    if (setup) startFrom(setup);
    setKindKey(key);
    setBizKind(quickKind(key));
    setKindText("");
    setKindTouched(true);
  };
  const pickFound = (found: BusinessKind) => {
    const setup = setupKindOf(found);
    startFrom(setup);
    setKindKey(setup.key);
    setBizKind(chosenKind(found));
    setKindText(found.names.en);
    setKindTouched(true);
  };
  const pickOwn = (words: string) => {
    const own = chosenKind(words);
    startFrom(GENERAL);
    setKindKey(GENERAL.key);
    setBizKind(own);
    setKindText(own?.label ?? "");
    setKindTouched(true);
  };

  const leave = () => {
    rememberSkip();
    void navigate({ to: "/" });
  };

  /* Each step writes as it is left, so nothing is lost if the tab closes half way. */
  const saveStep = async (): Promise<boolean> => {
    setLocal(null);
    try {
      // Typed in the finder and never picked: the kind it names exactly; else the owner's own words, kept with the
      // kind already chosen, or as their own kind when none was. Nothing typed is dropped without a word.
      const settled = at === "kind" ? settleTyped(kindText, bizKind) : null;
      let toSave = bizKind;
      if (settled && "found" in settled) {
        pickFound(settled.found);
        toSave = chosenKind(settled.found);
      } else if (settled && (!kindKey || kindKey === GENERAL.key)) {
        pickOwn(settled.own.label);
        toSave = { id: null, label: settled.own.label };
      } else if (settled && settled.own.id === null) {
        // A quick pick that is many kinds keeps no words of its own: the owner says which they meant.
        setLocal(`Pick one of the list for “${settled.own.label}”, or Something else to keep your own words.`);
        return false;
      } else if (settled) {
        setBizKind(settled.own);
        setKindTouched(true);
        toSave = settled.own;
      }
      if (at === "kind" && (kindTouched || settled)) {
        // A merge of the one key: what the business runs, or nothing for a quick pick that is many kinds.
        await saveSettings.mutateAsync({ doc: { directory: { kind: toSave } } });
      }
      if (at === "you") {
        await saveProfile.mutateAsync({
          name: name.trim(),
          timezone,
          currency,
          languages: langs.length ? langs.slice(0, 10) : [guessLang(timezone)],
        });
        // A merge: where the owner hears of requests, and the currencies taken besides theirs; nothing else.
        await saveSettings.mutateAsync({
          doc: {
            ...(ownerEmailHeld ? {} : ownerEmailDoc(ownerEmail)),
            payments: { currencies: others.filter((c) => c !== currency) },
          },
        });
      }
      if (at === "where") {
        // Skipped (no choice made), the inbox says it works anywhere, as before.
        const doc = areaDocOf(area);
        if (doc) await saveSettings.mutateAsync({ doc });
      }
      if (at === "doors") {
        await saveSettings.mutateAsync({ doc: doorsStepDoc(doors, kind, terms, kindKey !== savedKey) });
      }
      // Left for later, or a kitchen's menu brought from its till: nothing to save here. Brought from a shop, the
      // services asked for beside its products are still named here and saved below.
      if (at === "offer" && (offerHow === "later" || (offerHow === "bring" && kitchen))) return true;
      if (at === "offer" && kitchen) {
        const plan = dishPlan(
          dishes.map((d) => ({ ...d, section: d.section || (sectionChoices[0] ?? "Menu") })),
          currency,
          settings.data?.doc.menu?.sections ?? [],
        );
        if ("problem" in plan) {
          setLocal(plan.problem);
          return false;
        }
        if (plan.products.length) await saveSettings.mutateAsync({ doc: { menu: { sections: plan.sections } } });
        for (const p of plan.products) {
          const row = await productWrite.mutateAsync({ body: p.body });
          await foodApi.setItem(row.id, { ...EMPTY_MENU, section: p.section });
        }
        setDishesMade((n) => n + plan.products.length);
        setDishes([{ id: nextId, name: "", price: "", section: "" }]);
        setNextId((n) => n + 1);
        return true;
      }
      if (at === "place") {
        setPlaceError(null);
        setPlaceBusy(true);
        try {
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
          // A place to stay sees its property systems among what it can bring its rooms from.
          void qc.invalidateQueries({ queryKey: qk.integrations });
        } catch (e) {
          setPlaceError(e);
          throw e;
        } finally {
          setPlaceBusy(false);
        }
      }
      if (at === "rooms" && placeId && roomsMode === "now") {
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
        // Both checked before either is saved: a price that does not read stops the step with nothing half made.
        const planned = sections.includes("services") ? offerBodies(offers, "services", currency, asked) : null;
        const sold =
          offerHow === "now" && sections.includes("products") ? offerBodies(goods, "products", currency) : null;
        for (const p of [planned, sold]) {
          if (p && "problem" in p) {
            setLocal(p.problem);
            return false;
          }
        }
        if (planned && "kind" in planned && planned.kind === "services") {
          for (const body of planned.bodies) await serviceWrite.mutateAsync({ body });
        }
        if (sold && "kind" in sold && sold.kind === "products") {
          for (const body of sold.bodies) await productWrite.mutateAsync({ body });
        }
        setOffers([{ id: nextId, name: "", minutes: "60", price: "" }]);
        setGoods([{ id: nextId + 1, name: "", minutes: "0", price: "" }]);
        setNextId((n) => n + 2);
      }
      if (at === "hours" && (doors.booking || (kitchen && doors.order !== false))) {
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

  // Nothing is required that can wait: only a name, and somewhere agents can reach the business.
  const canAdvance =
    at === "kind" ||
    (at === "you" && name.trim().length > 0) ||
    (at === "where" && areaReady(area)) ||
    (at === "doors" && anyDoor(doors)) ||
    at === "offer" ||
    at === "hours" ||
    at === "place" ||
    (at === "rooms" && (roomsMode !== "now" || rooms.some((r) => r.name.trim()))) ||
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
    return (
      <Finished
        onOpen={leave}
        kind={kind}
        priced={priced || (known.data?.setup?.rates.length ?? 0) > 0}
        menuEmpty={kitchen && dishesMade === 0 && (products.data?.items.length ?? 0) === 0}
        missing={{
          services: !kitchen && doors.booking && (services.data?.items.length ?? 0) === 0,
          products: !kitchen && doors.products === true && (products.data?.items.length ?? 0) === 0,
          rooms: kind?.key === "stays" && roomsMode !== "now",
        }}
      />
    );

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
              {[...KINDS, GENERAL].map((k) => (
                <label key={k.key} className="chip">
                  <input
                    type="radio"
                    name="su-kind"
                    checked={kindKey === k.key}
                    onChange={() =>
                      // Something else starts from the owner's own words, never from a kind of the list's name.
                      k.key === GENERAL.key ? pickOwn(bizKind?.id ? "" : kindText) : pickQuick(k.key)
                    }
                  />
                  <span>{k.label}</span>
                </label>
              ))}
            </div>
            <div className="kind-find">
              <label className="label" htmlFor="su-kind-find">
                {kindKey === GENERAL.key && !bizKind ? "Name it, in your own words" : "Or find yours exactly"}
              </label>
              <KindPicker
                id="su-kind-find"
                text={kindText}
                onText={(t) => {
                  setKindText(t);
                  // Typed while "Something else" is chosen: their own words, until they pick one of the list.
                  if (kindKey === GENERAL.key && !bizKind?.id) {
                    setBizKind(chosenKind(t));
                    setKindTouched(true);
                  }
                }}
                onPick={pickFound}
                onOwnWords={pickOwn}
              />
            </div>
            <p className="hint">{kindLine(kind, bizKind)}</p>
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
              <Field id="su-cur" label="Currency" hint="Your prices are in it." error={problem?.field("currency")}>
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
            {others.length === 0 && !moreCurrencies ? (
              <button type="button" className="linkish" onClick={() => setMoreCurrencies(true)}>
                You take other currencies too?
              </button>
            ) : (
              <Field
                id="su-cur-more"
                label="You also take"
                optional
                hint={`Agents are told before they ask. Prices stay in ${currency}; nothing is converted.`}
                error={problem?.field("payments.currencies")}
              >
                <OtherCurrencies id="su-cur-more" own={currency} value={others} onChange={setOthers} />
              </Field>
            )}
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
              id="su-langs"
              label="Languages you speak"
              hint={langsLine(langs, kind?.key === "stays")}
              error={problem?.field("languages")}
            >
              <LanguagePicker
                id="su-langs"
                value={langs}
                onChange={(v) => {
                  setLangs(v.slice(0, 10));
                  setPicked((p) => ({ ...p, lang: true }));
                }}
              />
            </Field>
            {kind?.key !== "stays" && writtenIn(langs).length > 1 && (
              <Field id="su-lang" label="When theirs is none of these, write in">
                <select
                  id="su-lang"
                  className="input"
                  value={fallbackLang(langs)}
                  onChange={(e) => {
                    setLangs(languagesToSave(langs, e.target.value, true));
                    setPicked((p) => ({ ...p, lang: true }));
                  }}
                >
                  {writtenIn(langs).map((l) => (
                    <option key={l} value={l}>
                      {languageName(l)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}

        {at === "where" && (
          <>
            <h2 className="sec">Where you work</h2>
            <p className="lede small">Agents check a site against this before they ask.</p>
            <WhereYouWork value={area} onChange={setArea} shapes={work.data?.postal} />
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => {
                setArea(emptyArea(area.country));
                setStep((s) => Math.min(s + 1, steps.length - 1));
              }}
            >
              Skip: anywhere
            </button>
          </>
        )}

        {at === "doors" && (
          <>
            <h2 className="sec">What can agents do?</h2>
            <p className="lede small">
              Your customers' AI assistants reach you through these. Turn on as many as you like; each changes any time
              in Settings.
            </p>
            <div className="door-groups">
              {DOOR_GROUPS.map((g) => {
                const rows = doorRows(kind, listed).filter((d) => d.group === g.id);
                if (rows.length === 0) return null;
                return (
                  <section key={g.id} aria-label={g.label}>
                    <h3 className="door-group-label">{g.label}</h3>
                    <ul className="door-list">
                      {rows.map((d) => (
                        <li key={d.key} className="door-row">
                          {/* Said, not switched: what the inbox holds opens it, and nothing here closes it. */}
                          <Switch
                            checked={d.fixed === true || doors[d.key] === true}
                            disabled={d.fixed === true}
                            onChange={(on) => setDoors((all) => ({ ...all, [d.key]: on }))}
                          >
                            {d.label}
                          </Switch>
                          <span className="door-note">{d.line}</span>
                          {d.key === "booking" && doors.booking && (
                            <div className="door-more">
                              <Chips
                                legend="They can cancel"
                                value={terms.cancelMin}
                                options={cancelChoices(terms.cancelMin)}
                                onChange={(v) => setTerms((t) => ({ ...t, cancelMin: v }))}
                              />
                              <span className="door-note">
                                {settings.data?.doc.booking.lateCancellation === "refuse"
                                  ? "Later than that, they are sent to you."
                                  : "Later than that, it is still taken, and recorded as late."}
                              </span>
                            </div>
                          )}
                          {d.key === "negotiate" && doors.negotiate && (
                            <div className="door-more">
                              <Chips
                                legend="Your AI and rules may also take off"
                                value={terms.discountPct}
                                options={DISCOUNT_CHOICES.map((p) => ({
                                  value: p,
                                  label: p ? `Up to ${p}%` : "Nothing",
                                }))}
                                onChange={(v) => setTerms((t) => ({ ...t, discountPct: v }))}
                              />
                              <span className="door-note">{discountLine(terms.discountPct)}</span>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              <section aria-label="Paying">
                <h3 className="door-group-label">Paying</h3>
                <fieldset className="chips-field">
                  <legend className="label">How customers can pay you</legend>
                  <div className="chips">
                    {setupPayments(country).map((t) => (
                      <label key={t} className="chip">
                        <input
                          type="checkbox"
                          checked={terms.payments.includes(t)}
                          onChange={(e) =>
                            setTerms((all) => ({ ...all, payments: togglePayment(all.payments, t, e.target.checked) }))
                          }
                        />
                        {paymentName(t)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <p className="door-note">
                  Agents read this before they pay. To be paid online into your own account, connect Stripe or Mollie
                  after setup: accepted orders then carry a link to pay, and with Stripe a customer's assistant can pay
                  it itself once you switch that on.
                </p>
              </section>
            </div>
            {!anyDoor(doors) && <p className="hint">Agents can't reach you at all.</p>}
          </>
        )}

        {at === "offer" && (
          <>
            <h2 className="sec">{offerTitle(sections, doors.booking)}</h2>
            {sections.length === 0 ? (
              <p className="lede small">
                Nothing to list: agents can write to you. Go back and switch on booking or ordering to list what people
                book or buy.
              </p>
            ) : (
              <>
                <Chips
                  legend="How would you like to add them?"
                  value={offerHow}
                  options={bringable(sections).length ? OFFER_MODES : OFFER_MODES.filter((m) => m.value !== "bring")}
                  onChange={(m) => {
                    setOfferMode(m);
                    setLocal(null);
                  }}
                />
                {offerHow === "bring" && (
                  <>
                    {sections.includes("services") && <h3 className="door-group-label">Products</h3>}
                    <BringFrom ids={bringIds(sections)} feed={sections.includes("products")} />
                  </>
                )}
                {offerHow === "later" && <p className="hint">{laterLine(sections, doors)}</p>}
                {offerHow === "now" && kitchen && (
                  <>
                    <p className="lede small">
                      Two or three to start. Agents order only what is on your menu; add the rest and their allergens in
                      Settings → Menu.
                    </p>
                    {existing > 0 && (
                      <p className="hint">
                        This instance already has {existing} {existing === 1 ? "entry" : "entries"}. Dishes you add here
                        are added to them.
                      </p>
                    )}
                    <div className="stack">
                      {dishes.map((d, i) => (
                        <div className="offer row-glass" key={d.id}>
                          <Field id={`su-d-${d.id}`} label="Name">
                            <input
                              id={`su-d-${d.id}`}
                              className="input"
                              value={d.name}
                              placeholder={i === 0 ? (DISH_PLACEHOLDERS[kind?.key ?? ""] ?? "") : ""}
                              onChange={(e) =>
                                setDishes((all) => all.map((x) => (x.id === d.id ? { ...x, name: e.target.value } : x)))
                              }
                            />
                          </Field>
                          <Field id={`su-dp-${d.id}`} label="Price">
                            <MoneyInput
                              id={`su-dp-${d.id}`}
                              currency={currency}
                              value={d.price}
                              onChange={(v) =>
                                setDishes((all) => all.map((x) => (x.id === d.id ? { ...x, price: v } : x)))
                              }
                            />
                          </Field>
                          <Field id={`su-ds-${d.id}`} label="Section">
                            <select
                              id={`su-ds-${d.id}`}
                              className="input"
                              value={d.section || (sectionChoices[0] ?? "")}
                              onChange={(e) =>
                                setDishes((all) =>
                                  all.map((x) => (x.id === d.id ? { ...x, section: e.target.value } : x)),
                                )
                              }
                            >
                              {sectionChoices.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </Field>
                          {dishes.length > 1 && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-label={`Remove ${d.name || "this row"}`}
                              onClick={() => setDishes((all) => all.filter((x) => x.id !== d.id))}
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
                        setDishes((all) => [...all, { id: nextId, name: "", price: "", section: "" }]);
                        setNextId((n) => n + 1);
                      }}
                    >
                      <Plus className="icon" aria-hidden="true" />
                      Another dish
                    </button>
                  </>
                )}
                {offerHow !== "later" && !kitchen && (
                  <>
                    {offerHow === "now" && existing > 0 && (
                      <p className="hint">
                        This instance already has {existing} {existing === 1 ? "entry" : "entries"}. Anything you add
                        here is added to them.
                      </p>
                    )}
                    {sections.includes("services") && (
                      <>
                        {sections.includes("products") && <h3 className="door-group-label">Services</h3>}
                        <p className="lede small">
                          {offerHow === "bring"
                            ? "Named here: a shop or a till brings its products, not what people book or ask about."
                            : doors.booking
                              ? "One is enough to start. An agent asking what you offer is answered from this."
                              : "Optional: agents can ask for a price in their own words. Name what you do and they ask about it."}
                        </p>
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
                                    setOffers((all) =>
                                      all.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)),
                                    )
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
                                    onChange={(v) =>
                                      setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, price: v } : x)))
                                    }
                                  />
                                </Field>
                              )}
                              {doors.booking && (
                                <div className="wide">
                                  <LengthPicker
                                    legend="Length"
                                    value={o.minutes}
                                    onChange={(v) =>
                                      setOffers((all) => all.map((x) => (x.id === o.id ? { ...x, minutes: v } : x)))
                                    }
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
                        {(doors.booking || isTrade(kind)) &&
                          (syncOpen ? (
                            <BringFrom
                              ids={syncIds(kind)}
                              lede="These keep your times in step once connected in Settings → Integrations (it opens in a new tab): busy times in, bookings out. They do not bring your services; name those here."
                            />
                          ) : (
                            <button type="button" className="linkish" onClick={() => setSyncOpen(true)}>
                              {isTrade(kind)
                                ? "Already use a job tool or a calendar?"
                                : "Already use a calendar or a booking tool?"}
                            </button>
                          ))}
                      </>
                    )}
                    {offerHow === "now" && sections.includes("products") && (
                      <>
                        {sections.includes("services") && <h3 className="door-group-label">Products</h3>}
                        <p className="lede small">
                          A few to start, each with its price. Stock, options and the rest are in Settings → Products.
                        </p>
                        <div className="stack">
                          {goods.map((g, i) => (
                            <div className="offer row-glass" key={g.id}>
                              <Field id={`su-g-${g.id}`} label="Name">
                                <input
                                  id={`su-g-${g.id}`}
                                  className="input"
                                  value={g.name}
                                  placeholder={i === 0 ? "Linen tote bag" : ""}
                                  onChange={(e) =>
                                    setGoods((all) =>
                                      all.map((x) => (x.id === g.id ? { ...x, name: e.target.value } : x)),
                                    )
                                  }
                                />
                              </Field>
                              <Field id={`su-gp-${g.id}`} label="Price">
                                <MoneyInput
                                  id={`su-gp-${g.id}`}
                                  currency={currency}
                                  value={g.price}
                                  onChange={(v) =>
                                    setGoods((all) => all.map((x) => (x.id === g.id ? { ...x, price: v } : x)))
                                  }
                                />
                              </Field>
                              {goods.length > 1 && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  aria-label={`Remove ${g.name || "this row"}`}
                                  onClick={() => setGoods((all) => all.filter((x) => x.id !== g.id))}
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
                            setGoods((all) => [...all, { id: nextId, name: "", minutes: "0", price: "" }]);
                            setNextId((n) => n + 1);
                          }}
                        >
                          <Plus className="icon" aria-hidden="true" />
                          Another product
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )}
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
            <Chips
              legend="How would you like to add them?"
              value={roomsMode}
              options={OFFER_MODES}
              onChange={(m) => {
                setRoomsMode(m);
                setLocal(null);
              }}
            />
            {roomsMode === "bring" && <BringFrom ids={SOURCE_CARDS.rooms} lodging />}
            {roomsMode === "later" && (
              <p className="hint">
                Guests' assistants can ask for dates once your place has rooms: Settings → Property.
              </p>
            )}
            {roomsMode === "now" && (
              <>
                <p className="lede small">
                  One line per kind of room: how many you have, and how many people sleep in one. With a price a night,
                  each request comes with a quote ready to send.
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
                            onChange={(v) =>
                              setRooms((all) => all.map((x) => (x.id === r.id ? { ...x, price: v } : x)))
                            }
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
          </>
        )}

        {at === "hours" && (
          <>
            <h2 className="sec">When are you open?</h2>
            {doors.booking || (kitchen && doors.order !== false) ? (
              <>
                <p className="lede small">
                  {kitchen
                    ? "Agents are offered times to collect, and tables, inside these, never when you are closed."
                    : "Agents are offered free times inside these, never when you are closed."}
                </p>
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

/** How the offer step and the rooms step can be answered, one press each. */
const OFFER_MODES: readonly { readonly value: OfferMode; readonly label: string }[] = [
  { value: "now", label: "Add a few now" },
  { value: "bring", label: "Bring them from what you already use" },
  { value: "later", label: "Skip, add later" },
];

/** The offer step's heading, by what it asks for. */
function offerTitle(sections: readonly OfferSection[], booking: boolean): string {
  if (sections.includes("menu")) return "Your first dishes";
  if (sections.includes("services") && sections.includes("products")) return "What do you offer?";
  if (sections.includes("products")) return "What do you sell?";
  if (sections.length === 0) return "What you offer";
  return booking ? "What can people book?" : "What can people ask you about?";
}

/** The systems the offer can be brought from, each card once, in the order of the parts asked for. */
function bringIds(sections: readonly OfferSection[]): string[] {
  return [...new Set(bringable(sections).flatMap((x) => (x === "products" || x === "menu" ? SOURCE_CARDS[x] : [])))];
}

const isTrade = (kind: SetupKind | undefined) => kind?.key === "trades" || kind?.key === "projects";

/** What keeps a service's times in step: a trade's job tool first, then calendars and booking tools. */
function syncIds(kind: SetupKind | undefined): string[] {
  return [...new Set(isTrade(kind) ? [...SYNC_CARDS.work, ...SYNC_CARDS.times] : SYNC_CARDS.times)];
}

/** What waits for the offer when it is left for later, said once per door. */
function laterLine(sections: readonly OfferSection[], doors: WizardDoors): string {
  const lines: string[] = [];
  if (sections.includes("menu")) lines.push("Orders open once your menu has dishes: Settings → Menu.");
  if (sections.includes("services")) {
    lines.push(
      doors.booking
        ? "Booking opens once you add a service: Settings → Services."
        : "Agents can still ask for a price in their own words.",
    );
  }
  if (sections.includes("products")) lines.push("Ordering opens once you add a product: Settings → Products.");
  return lines.join(" ");
}

/** How long before a booking it can still be cancelled online, one press each; the one saved kept among them. */
function cancelChoices(current: number): { value: number; label: string }[] {
  const usual = [
    { value: 0, label: "Until it starts" },
    { value: 120, label: "Up to 2 h before" },
    { value: 1440, label: "Up to 24 h before" },
    { value: 2880, label: "Up to 48 h before" },
  ];
  if (usual.some((c) => c.value === current)) return usual;
  return [...usual, { value: current, label: `Up to ${durationWords(current).toLowerCase()} before` }].sort(
    (a, b) => a.value - b.value,
  );
}

/** How the last step names a preset's rules, and what they do, in a line each. */
const PRESET_WORDS: Readonly<Partial<Record<string, string>>> = {
  appointments: "bookings",
  trades: "requests for a price",
  shop: "orders",
  stays: "a place to stay",
  food: "a kitchen",
  bakery: "a bakery",
  cafe: "a café",
};
const PRESET_LINES: Readonly<Partial<Record<string, string>>> = {
  appointments: "Bookings in a free slot are confirmed, and everything else waits for you.",
  trades: "Requests for a price are flagged for you, and anything urgent goes to the top.",
  shop: "Small orders are accepted and asked to pay, and large ones wait for you.",
  stays:
    "A request is quoted from your rates as a draft for you to send, and nothing is confirmed on its own until you say so.",
  food: "Every order waits for you to accept it; tables in a free sitting are confirmed. In Settings → Kitchen you can let orders inside what you set aside be accepted at once.",
  bakery: "Every order waits for you to accept it; cakes made to order always do.",
  cafe: "Every order waits for you to accept it, until you choose otherwise in Settings → Kitchen.",
};

/** The end. What works now, and — just as important — what does not yet. */
function Finished({
  onOpen,
  kind,
  priced,
  menuEmpty = false,
  missing,
}: {
  onOpen: () => void;
  kind?: SetupKind | undefined;
  priced?: boolean | undefined;
  /** A kitchen with nothing on its menu yet: agents can order nothing until it has dishes. */
  menuEmpty?: boolean;
  /** What a door that is on still waits for: a service to book, a product to order, rooms. */
  missing?: { readonly services: boolean; readonly products: boolean; readonly rooms: boolean } | undefined;
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
          {menuEmpty && (
            <li>
              <b>Your menu.</b> Settings → Menu: dishes, options and allergens.
            </li>
          )}
          {missing?.services && (
            <li>
              <b>Something to book.</b> Settings → Services: booking opens once you add one.
            </li>
          )}
          {missing?.products && (
            <li>
              <b>Products.</b> Settings → Products, or your shop in Settings → Integrations: ordering opens with the
              first.
            </li>
          )}
          {missing?.rooms && (
            <li>
              <b>Rooms.</b> Settings → Property, unless your property system brings them.
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

/** The line under the first step's choice: what the chosen setup means, and that everything can change. */
function kindLine(kind: SetupKind | undefined, chosen: ChosenKind | null): string {
  if (!kind) return "Pick the nearest, or find yours. You can change everything later.";
  if (kind.key === GENERAL.key) {
    return chosen ? `${chosen.label}. ${GENERAL.line}` : `Name it in your own words. ${GENERAL.line}`;
  }
  const quick = chosen && chosen.id === quickKind(kind.key)?.id;
  return chosen && !quick ? `${chosen.label}, set up like ${kind.label.toLowerCase()}. ${kind.line}` : kind.line;
}

/** The languages the inbox writes its own emails and pages in: customers' two, guests' six. */
const writes = (stays: boolean): readonly string[] => (stays ? GUEST_LANGS : ["en", "pt"]);
const primary = (tag: string) => tag.toLowerCase().split(/[-_]/)[0] ?? "";

/** Of the languages chosen, the ones the inbox writes to customers in, each once, in the owner's order. */
function writtenIn(langs: readonly string[]): string[] {
  return [...new Set(langs.map(primary).filter((l) => writes(false).includes(l)))];
}

/**
 * What the inbox writes to a customer in when their own language is not one it has (core `customerLang`): the first
 * of the business's languages it has, else English.
 */
function fallbackLang(langs: readonly string[]): string {
  return writtenIn(langs)[0] ?? "en";
}

/**
 * The line under the languages: customers write in any of them; the inbox answers in theirs where it has it, and
 * says in which otherwise, so a business that speaks German knows its emails are in English for now. A guest whose
 * language is none of a stay's six is answered in English (core `stayLang`), whatever the owner speaks.
 */
function langsLine(langs: readonly string[], stays: boolean): string {
  const names = writes(stays).map((l) => languageName(l));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : (names[0] ?? "");
  const who = stays ? "Guests" : "Customers";
  const otherwise = languageName(stays ? "en" : fallbackLang(langs));
  return `${who} can write in any of them. Your inbox answers in theirs when it is ${list}; otherwise in ${otherwise}.`;
}
