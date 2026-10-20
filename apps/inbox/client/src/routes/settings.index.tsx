import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  CountrySelect,
  CurrencySelect,
  DurationPicker,
  LanguagePicker,
  MoneyInput,
  SourceTag,
  Stepper,
  TimeZonePicker,
} from "../components/Choosers";
import { DownloadInbox } from "../components/DownloadInbox";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, Switch } from "../components/Form";
import { problemOf } from "../lib/api";
import { session } from "../lib/auth";
import { currencyNote } from "../lib/currencies";
import {
  choiceForLink,
  cleanDoorUrl,
  detectedDoors,
  doorPlatform,
  doorPlatformFit,
  doorPlatformOf,
  doorSwitchDoc,
  doorViews,
  ELSEWHERE_KINDS,
  type ElsewhereEntry,
  type ElsewhereKind,
  elsewhereDoc,
  linkProblem,
  noWebsiteWords,
  ownDomains,
  pickedPlatformNote,
  placeOf,
  platformChoices,
  prefillFrom,
  shortLink,
  stillHereWords,
  waitWords,
} from "../lib/doors";
import { DURATION_PRESETS } from "../lib/durations";
import { emailLangOf, mailBannerLines } from "../lib/format";
import { countryOfZone } from "../lib/geo";
import { languageName, languagesToSave } from "../lib/languages";
import {
  qk,
  useAvailability,
  useMailStatus,
  useNetworks,
  useProducts,
  useProfile,
  useReceiptStatus,
  useSaveProfile,
  useSaveSettings,
  useServices,
  useSettings,
} from "../lib/queries";
import { type SettingsForm as SettingsFormState, toSettingsDoc, toSettingsForm } from "../lib/settings";
import { clearSources, sourceNote } from "../lib/sources";
import type { Profile, SettingsDoc } from "../lib/types";

export const Route = createFileRoute("/settings/")({
  component: GeneralPage,
});

/** A settings write the page makes on its own (a door's switch), and what comes of it. */
type PatchSettings = (doc: Record<string, unknown>, done?: () => void) => void;

/**
 * What agents can do (three switches, saved as they are pressed), who the business is and how it
 * takes bookings; the rest folded under Advanced. One bar saves every change on the page, and shows
 * only while there is one. The switches write small patches while the page may hold edits: the form
 * follows the versions its own patches made, so its save is not refused as a change made somewhere
 * else, and a change truly made elsewhere still is.
 */
function GeneralPage() {
  const profile = useProfile();
  const settings = useSettings();
  const qc = useQueryClient();
  const patch = useSaveSettings();
  const [saved, setSaved] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  /** Versions this page moved the settings on from, each to the one its own patch made. */
  const ours = useRef(new Map<number, number>());
  const expectedFor = (loaded: number) => {
    let v = loaded;
    for (let i = 0; i < 100 && ours.current.has(v); i++) v = ours.current.get(v) as number;
    return v;
  };
  const patchSettings: PatchSettings = (doc, done) => {
    const from = settings.data?.version;
    patch.mutate(
      { doc, ...(from !== undefined ? { expected_version: from } : {}) },
      {
        onSuccess: (data) => {
          if (from !== undefined) ours.current.set(from, data.version);
          done?.();
        },
      },
    );
  };
  const reload = () => {
    setSaved(null);
    patch.reset();
    void qc.invalidateQueries({ queryKey: qk.settings }).then(() => setFormKey((k) => k + 1));
  };
  const patchProblem = patch.error ? problemOf(patch.error) : null;
  const failed = profile.isError ? profile.error : settings.isError ? settings.error : null;
  return (
    <>
      {saved && <Toast tone="success" text={saved} onDismiss={() => setSaved(null)} />}
      {patchProblem && (
        <Toast
          tone="danger"
          text={patchProblem.code === "version_conflict" ? "Settings changed somewhere else." : "That was not saved."}
          sub={patchProblem.code === "version_conflict" ? "Reload to see the latest." : patchProblem.detail}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
              Reload
            </button>
          }
        />
      )}
      <MailBanner />
      {settings.data && <DoorsCard doc={settings.data.doc} pending={patch.isPending} onPatch={patchSettings} />}
      {(profile.isPending || settings.isPending) && <Loading />}
      {failed && (
        <div className="card glass">
          <ErrorState
            title="Could not load the settings"
            text={problemOf(failed).detail}
            onRetry={() => void Promise.all([profile.refetch(), settings.refetch()])}
          />
        </div>
      )}
      {profile.data && settings.data && (
        <GeneralForm
          key={formKey}
          profile={profile.data}
          initial={settings.data}
          expectedVersion={expectedFor}
          onSaved={() => {
            setSaved("Saved.");
            setFormKey((k) => k + 1);
          }}
          onReload={reload}
        />
      )}
      <DownloadInbox />
    </>
  );
}

/**
 * What is wrong with email, when something is: no mail service, no address to send from, or no links
 * in the emails. Nothing when all is well, as on every hosted inbox, whose host sends its mail.
 */
function MailBanner() {
  const mail = useMailStatus();
  const lines = mailBannerLines(mail.data);
  if (lines.length === 0) return null;
  return (
    <div className="test-banner" role="status">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function Loading() {
  return (
    <div className="card glass" aria-busy="true">
      <div className="skeleton sk-title" />
      <div className="skeleton sk-line" />
    </div>
  );
}

// ---- what agents can do ---------------------------------------------------------------------

/**
 * Three switches, one line each, saved as they are pressed. A booking switched on that cannot open
 * yet shows as waiting, says for what, and links the way there. Bookings taken at another site
 * (ADR-031) take the booking switch's row: no switch, where agents send them, Change and Take
 * bookings here. Orders, which have no switch, get their own line under the switches.
 */
function DoorsCard({ doc, pending, onPatch }: { doc: SettingsDoc["doc"]; pending: boolean; onPatch: PatchSettings }) {
  // The owner's own read of the doors: the public one answers no agent until the inbox is connected.
  const profile = useProfile();
  const services = useServices();
  const availability = useAvailability();
  // The Integrations gallery's "Send agents there" lands here with the editor open (`#elsewhere`).
  const [editing, setEditing] = useState<ElsewhereKind | null>(() => {
    if (typeof window === "undefined" || window.location.hash !== "#elsewhere") return null;
    return ELSEWHERE_KINDS.find((k) => !doc.doorsElsewhere.some((d) => d.itemType === k)) ?? null;
  });
  if (!profile.data) return null;
  const a = availability.data;
  const windows = (w: object | undefined) => Object.values(w ?? {}).some((d) => Array.isArray(d) && d.length > 0);
  const views = doorViews({
    doors: doc.doors,
    itemTypes: profile.data.item_types,
    hasService: (services.data?.items ?? []).some((s) => s.active === 1 && s.price?.model !== "quote"),
    hasHours: Boolean(a && ((a.weekly_set && windows(a.weekly)) || a.overrides.some((o) => windows(o.weekly)))),
    doorsElsewhere: doc.doorsElsewhere,
  });
  const entries = doc.doorsElsewhere;
  const away = entries.find((d) => d.itemType === "booking");
  const domains = ownDomains(profile.data.domain, doc.directory.url);
  const still = stillHereWords({
    message: profile.data.item_types.includes("message"),
    quoteRequest: profile.data.item_types.includes("quote_request"),
  });
  return (
    <section className="card glass doors" aria-labelledby="doors-title">
      <h3 className="sec" id="doors-title">
        What agents can do
      </h3>
      <ul className="door-list">
        {views.map((v) => {
          if (v.key === "booking" && away) {
            return (
              <li key={v.key} className="door-row door-away">
                <span className="door-away-mark" aria-hidden="true">
                  →
                </span>
                <span className="door-away-text">
                  Agents send bookings to <strong>{placeOf(away)}</strong>
                </span>
                <a className="else-link" href={away.url} target="_blank" rel="noopener noreferrer">
                  {shortLink(away.url)}
                </a>
                <span className="else-acts">
                  <button
                    type="button"
                    className="linkish"
                    disabled={pending || editing === "booking"}
                    onClick={() => setEditing("booking")}
                  >
                    Change
                  </button>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    className="linkish"
                    disabled={pending}
                    onClick={() => onPatch(elsewhereDoc(entries, "booking", null))}
                  >
                    Take bookings here
                  </button>
                </span>
              </li>
            );
          }
          const why = v.needs ? `door-${v.key}-why` : undefined;
          return (
            <li key={v.key} className="door-row">
              <Switch
                checked={v.on}
                pending={Boolean(v.needs)}
                describedBy={why}
                disabled={pending}
                onChange={(on) => onPatch(doorSwitchDoc(v.key, on))}
              >
                <span>
                  {v.label}
                  {v.needs && <span className="door-wait"> · {waitWords(v.needs)}</span>}
                </span>
              </Switch>
              {v.needs && (
                <span className="door-note" id={why}>
                  {v.needs !== "hours" && <Link to="/settings/services">Add a service</Link>}
                  {v.needs === "service_and_hours" && <span aria-hidden="true"> · </span>}
                  {v.needs !== "service" && <Link to="/settings/availability">Set hours</Link>}
                </span>
              )}
              {v.key === "message" && !v.on && <span className="door-note">Email still reaches you.</span>}
            </li>
          );
        })}
      </ul>
      {views.every((v) => !v.open) && entries.length === 0 && <p className="hint">Agents can't reach you at all.</p>}
      <Elsewhere
        entries={entries}
        domains={domains}
        still={still}
        editing={editing}
        pending={pending}
        onEdit={setEditing}
        onPatch={onPatch}
      />
    </section>
  );
}

// ---- bookings or orders on another site --------------------------------------------------------

const KIND_WORDS: Record<
  ElsewhereKind,
  { readonly plural: string; readonly lower: string; readonly add: string; readonly paste: string }
> = {
  booking: {
    plural: "Bookings",
    lower: "bookings",
    add: "Take bookings on another site?",
    paste: "Paste the link to your booking page",
  },
  order: {
    plural: "Orders",
    lower: "orders",
    add: "Take orders on another site?",
    paste: "Paste the link to your shop",
  },
};

/** The chooser's value for a page on no platform of the list. */
const ANOTHER = "other";

/** What a network already found for this business on a platform that takes this kind, for the owner to check. */
function foundPlatform(detected: readonly { type: string; url: string }[], kind: ElsewhereKind): string {
  for (const d of detected) {
    const p = d.type.startsWith("platform:") ? doorPlatform(d.type.slice(9)) : doorPlatformOf(d.url, kind);
    if (p?.item_types.includes(kind)) return p.id;
  }
  return "";
}

/**
 * Orders taken on another site, on their own line (bookings sit in the booking switch's row): the place by name, the
 * platform the owner picked when agents name it by its address, its link, Change and Remove. A quiet link opens the
 * editor for a kind not sent anywhere yet.
 */
function Elsewhere({
  entries,
  domains,
  still,
  editing,
  pending,
  onEdit,
  onPatch,
}: {
  entries: readonly ElsewhereEntry[];
  domains: readonly string[];
  still: string;
  editing: ElsewhereKind | null;
  pending: boolean;
  onEdit: (kind: ElsewhereKind | null) => void;
  onPatch: PatchSettings;
}) {
  const free = ELSEWHERE_KINDS.filter((k) => !entries.some((d) => d.itemType === k));
  const orders = entries.filter((d) => d.itemType === "order");
  return (
    <div className="elsewhere" id="elsewhere">
      {orders.length > 0 && (
        <ul className="else-list">
          {orders.map((d) => {
            if (editing === d.itemType) return null;
            const picked = pickedPlatformNote(d);
            return (
              <li key={d.itemType} className="else-row">
                <span className="else-what">
                  {KIND_WORDS[d.itemType].plural} at <strong>{placeOf(d)}</strong>
                  {picked && <span className="else-picked"> · {picked}</span>}
                </span>
                <a className="else-link" href={d.url} target="_blank" rel="noopener noreferrer">
                  {shortLink(d.url)}
                </a>
                <span className="else-acts">
                  <button type="button" className="linkish" disabled={pending} onClick={() => onEdit(d.itemType)}>
                    Change
                  </button>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    className="linkish"
                    disabled={pending}
                    onClick={() => onPatch(elsewhereDoc(entries, d.itemType, null))}
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {editing ? (
        <ElsewhereEditor
          key={editing}
          kind={editing}
          kinds={entries.some((d) => d.itemType === editing) ? [editing] : free}
          entries={entries}
          domains={domains}
          still={still}
          pending={pending}
          onKind={onEdit}
          onCancel={() => onEdit(null)}
          onSave={(kind, next) => onPatch(elsewhereDoc(entries, kind, next), () => onEdit(null))}
        />
      ) : (
        free.length > 0 && (
          <button type="button" className="linkish else-add" disabled={pending} onClick={() => onEdit(free[0] ?? null)}>
            {free.length === 2 ? "Take bookings or orders on another site?" : KIND_WORDS[free[0] as ElsewhereKind].add}
          </button>
        )
      )}
    </div>
  );
}

/**
 * Paste the link, or pick where first. The link field is open from the start: a link pasted from a listed platform
 * picks it, and one on no listed platform goes as Another page, so the chooser is only needed for a shop on the
 * business's own website. The link starts from what is already known: the one saved, the page a network found for
 * this business on that platform (with a word to use the platform's direct link if it has one), or the business's own
 * website for a shop there. Tracking is taken off as it is pasted.
 */
function ElsewhereEditor({
  kind,
  kinds,
  entries,
  domains,
  still,
  pending,
  onKind,
  onCancel,
  onSave,
}: {
  kind: ElsewhereKind;
  kinds: readonly ElsewhereKind[];
  entries: readonly ElsewhereEntry[];
  domains: readonly string[];
  still: string;
  pending: boolean;
  onKind: (kind: ElsewhereKind) => void;
  onCancel: () => void;
  onSave: (kind: ElsewhereKind, next: { url: string; platform?: string | undefined }) => void;
}) {
  const ids = useId();
  const networks = useNetworks();
  const detected = detectedDoors(networks.data?.networks);
  const current = entries.find((d) => d.itemType === kind);
  const domain = domains[0] ?? null;
  const [choice, setChoice] = useState<string>(() =>
    current ? (current.platform ?? doorPlatformOf(current.url, kind)?.id ?? ANOTHER) : foundPlatform(detected, kind),
  );
  const [start] = useState(() =>
    choice ? prefillFrom(choice === ANOTHER ? "" : choice, kind, { current, detected, domain }) : null,
  );
  const [url, setUrl] = useState(start?.url ?? "");
  const [from, setFrom] = useState(start?.from ?? "none");
  const [touched, setTouched] = useState(false);
  const [cleaned, setCleaned] = useState(false);
  const [moved, setMoved] = useState(false);
  const platform = choice && choice !== ANOTHER ? choice : "";
  const named = doorPlatform(platform);
  const problem = choice ? linkProblem(url, platform, kind, domains) : url.trim() ? "Choose where." : "Paste the link.";
  // A shop on the business's own website waits for the website: said at once, and Save waits with it. A page on the
  // platform's own host for the business (a name on myshopify.com) needs no website to check it against.
  const waiting =
    Boolean(named?.own_site) &&
    domains.length === 0 &&
    (!url.trim() || (named !== undefined && doorPlatformFit(url.trim(), named, kind) === "own_site"));
  const pick = (next: string) => {
    setChoice(next);
    setTouched(false);
    setMoved(false);
    const p = doorPlatform(next === ANOTHER ? "" : next);
    // A link the owner already gave that fits the new place is kept, never thrown away.
    const fit = p && url.trim() ? doorPlatformFit(url.trim(), p, kind) : null;
    if (url.trim() && (!p || fit === "on_platform" || fit === "own_site")) return;
    const prefill = prefillFrom(next === ANOTHER ? "" : next, kind, { current, detected, domain });
    if (prefill.url) {
      setUrl(prefill.url);
      setFrom(prefill.from);
    }
  };
  // The networks' answer can land after the editor opens: what they found is picked then, once, if nothing is yet.
  const found = foundPlatform(detected, kind);
  const [offered, setOffered] = useState(Boolean(choice));
  useEffect(() => {
    if (offered || !found || choice || url.trim()) return;
    setOffered(true);
    pick(found);
  });
  const take = (raw: string) => {
    const clean = cleanDoorUrl(raw.trim());
    setCleaned(clean !== raw.trim());
    setUrl(clean);
    setFrom("none");
    // A link from a listed platform picks it; one on none goes as Another page.
    const next = choiceForLink(clean, choice, kind, ANOTHER);
    if (next.choice !== choice) setChoice(next.choice);
    setMoved(next.moved);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || pending) return;
    onSave(kind, { url, platform: platform || undefined });
  };
  const direct =
    from === "found" && named && !named.own_site
      ? `Found on ${named.name}. If ${named.name} gives you a direct booking link, paste that one.`
      : "";
  const hint = waiting
    ? noWebsiteWords(kind)
    : touched && problem
      ? problem
      : cleaned
        ? "Tracking taken off the link."
        : moved
          ? "Saved as a page of yours, named by its address."
          : direct || `Agents send people there for ${KIND_WORDS[kind].lower}.${still ? ` ${still}` : ""}`;
  // Before the owner has given a link, the website it waits for is a quiet hint; after, it is what is wrong.
  const isError = Boolean(touched && problem);
  return (
    <form className="else-edit" onSubmit={save} aria-label={`Where ${KIND_WORDS[kind].lower} are taken`}>
      {kinds.length > 1 && (
        <fieldset className="seg">
          <legend className="sr-only">What</legend>
          {kinds.map((k) => (
            <button key={k} type="button" aria-pressed={k === kind} onClick={() => onKind(k)}>
              {KIND_WORDS[k].plural}
            </button>
          ))}
        </fieldset>
      )}
      <div className="else-fields">
        <div className="else-field else-where">
          <label className="label" htmlFor={`${ids}-where`}>
            {KIND_WORDS[kind].plural} at
          </label>
          <select id={`${ids}-where`} className="input" value={choice} onChange={(e) => pick(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
            {platformChoices(kind).map(({ group, platforms }) => (
              <optgroup key={group.id} label={group.label}>
                {platforms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={ANOTHER}>Another page</option>
          </select>
        </div>
        <div className="else-field">
          <label className="label" htmlFor={`${ids}-link`}>
            Link
          </label>
          <input
            id={`${ids}-link`}
            className="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              named
                ? named.hosts.length
                  ? `Your page on ${named.name}`
                  : `A page on your website${domain ? ` (${domain})` : ""}`
                : choice === ANOTHER
                  ? "https://"
                  : KIND_WORDS[kind].paste
            }
            value={url}
            onChange={(e) => {
              setCleaned(false);
              setMoved(false);
              setFrom("none");
              setUrl(e.target.value);
            }}
            onPaste={(e) => {
              e.preventDefault();
              take(e.clipboardData.getData("text"));
              setTouched(true);
            }}
            onBlur={() => {
              if (url.trim()) {
                take(url);
                setTouched(true);
              }
            }}
            aria-invalid={isError}
            aria-describedby={`${ids}-hint`}
          />
        </div>
        <p className={isError ? "hint error" : "hint"} id={`${ids}-hint`} role={isError ? "alert" : undefined}>
          {hint}
        </p>
      </div>
      <div className="else-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={pending || waiting || Boolean(problem && touched)}
        >
          Save
        </button>
      </div>
    </form>
  );
}

// ---- the page's one form ----------------------------------------------------------------------

interface ProfileDraft {
  readonly name: string;
  readonly description: string;
  readonly domain: string;
  readonly timezone: string;
  readonly currency: string;
  /** The language customers' emails are in. */
  readonly emailLang: "en" | "pt";
  /** Every language the business speaks, in its order. */
  readonly languages: readonly string[];
}

const DESCRIPTION_MAX = 500;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Who the business is and how it takes bookings, then Advanced. Everything here is saved by the one
 * bar at the bottom of the screen: the business's row first (`PUT /profile`), then one settings write
 * with the rest, so a save never half happens on the page's side.
 */
function GeneralForm({
  profile,
  initial,
  expectedVersion,
  onSaved,
  onReload,
}: {
  profile: Profile;
  initial: SettingsDoc;
  expectedVersion: (loaded: number) => number;
  onSaved: () => void;
  onReload: () => void;
}) {
  const doc = initial.doc;
  const [startProfile] = useState<ProfileDraft>(() => ({
    name: profile.name,
    description: doc.directory.description,
    domain: profile.domain ?? "",
    timezone: profile.timezone,
    currency: profile.currency,
    emailLang: emailLangOf(profile.languages),
    languages: [...profile.languages],
  }));
  const [startForm] = useState<SettingsFormState>(() => toSettingsForm(doc, initial.redacted ?? []));
  const [draft, setDraft] = useState(startProfile);
  const [form, setForm] = useState(startForm);
  const [loaded] = useState(initial.version);
  const locked = initial.locked ?? [];
  /** Whether the host holds this setting: shown as it is, never changed here. */
  const held = (path: string) => locked.some((l) => path === l || path.startsWith(`${l}.`));
  /** An inbox someone runs for the business: buying is not part of it, nor the host's own knobs. */
  const hosted = held("email") || profile.home !== undefined;
  const saveProfile = useSaveProfile();
  const saveSettings = useSaveSettings();
  const [problemFrom, setProblemFrom] = useState<"profile" | "settings" | null>(null);
  const problem =
    problemFrom === "profile" && saveProfile.error
      ? problemOf(saveProfile.error)
      : problemFrom === "settings" && saveSettings.error
        ? problemOf(saveSettings.error)
        : null;
  const conflict = problem?.code === "version_conflict";
  const busy = saveProfile.isPending || saveSettings.isPending;
  const profileDirty = !same(draft, startProfile);
  const formDirty = !same(form, startForm);
  const dirty = profileDirty || formDirty;
  const setP = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const set = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const field = (path: string) => (problemFrom === "settings" ? problem?.field(path) : undefined);
  const pfield = (path: string) => (problemFrom === "profile" ? problem?.field(path) : undefined);
  const listField = (path: string) =>
    field(path) ??
    (problemFrom === "settings" ? problem?.fields?.find((f) => f.path.includes(`${path}.`))?.message : undefined);
  const sources = doc.setup.sources;

  // Leaving with changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !dirty) return;
    setProblemFrom(null);
    try {
      if (profileDirty) {
        setProblemFrom("profile");
        const name = draft.name.trim();
        await saveProfile.mutateAsync({
          // An empty name is left as it is, so the rest can still be saved.
          ...(name ? { name } : {}),
          ...(profile.domain_held ? {} : { domain: draft.domain.trim() ? draft.domain.trim().toLowerCase() : null }),
          timezone: draft.timezone,
          currency: draft.currency,
          // Reordered only when the email language changed: the business's own order is kept.
          languages: languagesToSave(draft.languages, draft.emailLang, draft.emailLang !== startProfile.emailLang),
        });
      }
      const description = draft.description.trim();
      const next: Record<string, unknown> = {
        ...(formDirty ? toSettingsDoc(form) : {}),
        ...(description !== doc.directory.description ? { directory: { description } } : {}),
      };
      // Saved by the owner: what was read and what they saved, they have checked.
      const checked = clearSources(
        sources,
        ...(profileDirty
          ? ["profile.name", "profile.currency", "profile.languages", "profile.timezone", "directory.description"]
          : []),
        ...(form.legalCountry !== startForm.legalCountry ? ["commerce.legal.country"] : []),
      );
      if (checked) next.setup = checked.setup;
      if (Object.keys(next).length) {
        setProblemFrom("settings");
        await saveSettings.mutateAsync({ doc: next, expected_version: expectedVersion(loaded) });
      }
      setProblemFrom(null);
      onSaved();
    } catch {
      // The problem is shown from the mutation's own error, beside its field.
    }
  };
  const discard = () => {
    setDraft(startProfile);
    setForm(startForm);
    setProblemFrom(null);
    saveProfile.reset();
    saveSettings.reset();
  };

  return (
    <form className="stack general" onSubmit={(e) => void save(e)}>
      {conflict && (
        <Toast
          tone="danger"
          text="Settings changed somewhere else since you opened them."
          sub="Reload to see the latest, then make your change again."
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={onReload}>
              Reload
            </button>
          }
        />
      )}
      {problem && !conflict && !problem.fields?.length && (
        <Toast tone="danger" text="That was not saved." sub={problem.detail} />
      )}
      <BusinessCard
        profile={profile}
        draft={draft}
        set={setP}
        sources={sources}
        hosted={hosted}
        field={pfield}
        descriptionError={field("directory.description")}
      />
      <BookingsCard form={form} set={set} field={field} />
      <Advanced>
        <AdvancedSections
          form={form}
          set={set}
          field={field}
          listField={listField}
          held={held}
          hosted={hosted}
          currency={draft.currency}
          timezone={draft.timezone}
          sources={sources}
          home={profile.home}
        />
      </Advanced>
      {dirty && (
        <section className="savebar glass-strong" aria-label="Unsaved changes">
          <span className="savebar-text">Unsaved changes</span>
          <button type="button" className="btn btn-ghost" onClick={discard} disabled={busy}>
            Discard
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Save changes
          </button>
        </section>
      )}
    </form>
  );
}

// ---- the business ---------------------------------------------------------------------------

function BusinessCard({
  profile,
  draft,
  set,
  sources,
  hosted,
  field,
  descriptionError,
}: {
  profile: Profile;
  draft: ProfileDraft;
  set: <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => void;
  sources: SettingsDoc["doc"]["setup"]["sources"];
  hosted: boolean;
  field: (path: string) => string | undefined;
  descriptionError: string | undefined;
}) {
  const services = useServices();
  const products = useProducts();
  const prices = [
    ...(services.data?.items ?? []).flatMap((s) =>
      s.price && s.price.model !== "quote" && s.price.value !== undefined ? [{ currency: s.price.currency }] : [],
    ),
    ...(hosted ? [] : (products.data?.items ?? []).map((p) => ({ currency: p.price.currency }))),
  ];
  const note = currencyNote(draft.currency, profile.currency, prices);
  // The language customers' emails can be in: the chosen ones the inbox writes in.
  const mailable = (["en", "pt"] as const).filter((c) =>
    draft.languages.some((l) => l.toLowerCase().split(/[-_]/)[0] === c),
  );
  const emailOptions: ("en" | "pt")[] = mailable.length ? [...mailable] : ["en", "pt"];
  if (!emailOptions.includes(draft.emailLang)) emailOptions.push(draft.emailLang);
  return (
    <section className="card glass stack" aria-labelledby="business-title">
      <h3 className="sec" id="business-title">
        Business
      </h3>
      <div className="grid2 business-grid">
        <div>
          <div className="label-line">
            <label className="label" htmlFor="p-name">
              Name
            </label>
            <SourceTag source={sourceNote(sources, "profile.name")} />
          </div>
          <input
            id="p-name"
            className="input"
            value={draft.name}
            autoComplete="organization"
            aria-invalid={field("name") ? true : undefined}
            onChange={(e) => set("name", e.target.value)}
          />
          {field("name") ? (
            <div className="hint error" role="alert">
              {field("name")}
            </div>
          ) : (
            !draft.name.trim() && <div className="hint">Agents and customers see it.</div>
          )}
        </div>
        <WebsiteField
          profile={profile}
          value={draft.domain}
          onChange={(v) => set("domain", v)}
          error={field("domain")}
        />
        <div>
          <div className="label-line">
            <label className="label" htmlFor="p-tz">
              Time zone
            </label>
            <SourceTag source={sourceNote(sources, "profile.timezone")} />
          </div>
          <TimeZonePicker
            id="p-tz"
            value={draft.timezone}
            onChange={(v) => set("timezone", v)}
            describedBy="p-tz-hint"
          />
          {field("timezone") ? (
            <div className="hint error" role="alert">
              {field("timezone")}
            </div>
          ) : (
            <div className="hint" id="p-tz-hint">
              Hours and bookings use this time zone.
            </div>
          )}
        </div>
        <div>
          <div className="label-line">
            <label className="label" htmlFor="p-currency">
              Currency
            </label>
            <SourceTag source={sourceNote(sources, "profile.currency")} />
          </div>
          <CurrencySelect id="p-currency" value={draft.currency} onChange={(v) => set("currency", v)} />
          {field("currency") ? (
            <div className="hint error" role="alert">
              {field("currency")}
            </div>
          ) : (
            note && <div className="hint">{note}</div>
          )}
        </div>
        <div className="wide">
          <div className="label-line">
            <label className="label" htmlFor="p-desc">
              Description
            </label>
            <span className="opt">· optional</span>
            <SourceTag source={sourceNote(sources, "directory.description")} />
          </div>
          <textarea
            id="p-desc"
            className="input autogrow"
            rows={2}
            maxLength={DESCRIPTION_MAX}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
          />
          <div className="hint-row">
            <span className={descriptionError ? "hint error" : "hint"}>
              {descriptionError ?? "A sentence or two, in public."}
            </span>
            <span className="hint count">
              {draft.description.length}/{DESCRIPTION_MAX}
            </span>
          </div>
        </div>
        <div className="wide">
          <div className="label-line">
            <label className="label" htmlFor="p-langs">
              Languages you speak
            </label>
            <SourceTag source={sourceNote(sources, "profile.languages")} />
          </div>
          <LanguagePicker id="p-langs" value={draft.languages} onChange={(v) => set("languages", v)} />
          {field("languages") && (
            <div className="hint error" role="alert">
              {field("languages")}
            </div>
          )}
        </div>
        <Field
          id="p-email-lang"
          label="Customers' emails are in"
          hint="Unless they write in another of your languages."
        >
          <select
            id="p-email-lang"
            className="input"
            value={draft.emailLang}
            onChange={(e) => set("emailLang", e.target.value === "pt" ? "pt" : "en")}
          >
            {emailOptions.map((c) => (
              <option key={c} value={c}>
                {languageName(c)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </section>
  );
}

/**
 * The business's website. Its own to type on an inbox it runs itself; on one a host runs for it, the
 * site it joined from, as text, with whether the inbox is connected to it yet and the way to do it.
 */
function WebsiteField({
  profile,
  value,
  onChange,
  error,
}: {
  profile: Profile;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
}) {
  const home = profile.home;
  if (profile.domain_held) {
    const domain = profile.domain ?? home?.domain ?? "";
    const connected = home ? home.linked : Boolean(profile.domain);
    return (
      <div>
        <span className="label">Website</span>
        <p className="readonly-line">
          {domain ? <span className="mono-soft">{domain}</span> : <span>No website yet</span>}
          <span className="readonly-sep" aria-hidden="true">
            ·
          </span>
          <span className={connected ? "readonly-ok" : "readonly-wait"}>
            {connected ? "connected to your inbox" : "not connected yet"}
          </span>
          {!connected && home?.connect_url && (
            <a className="readonly-action" href={home.connect_url}>
              Connect
            </a>
          )}
        </p>
        <div className="hint">Set when you joined.</div>
      </div>
    );
  }
  return (
    <Field id="p-domain" label="Website" optional error={error} hint="Where agents find you, like example.com.">
      <input
        id="p-domain"
        className="input"
        inputMode="url"
        spellCheck={false}
        placeholder="example.com"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

// ---- bookings -------------------------------------------------------------------------------

type SetForm = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => void;

function BookingsCard({
  form,
  set,
  field,
}: {
  form: SettingsFormState;
  set: SetForm;
  field: (path: string) => string | undefined;
}) {
  return (
    <section className="card glass stack" aria-labelledby="bookings-title">
      <h3 className="sec" id="bookings-title">
        Bookings
      </h3>
      <div className="grid2">
        <DurationPicker
          id="s-cancel"
          legend="Customers can cancel up to"
          unit="min"
          presets={DURATION_PRESETS.cancellation}
          value={form.cancellationWindowMin}
          onChange={(v) => set("cancellationWindowMin", v)}
          hint="Before a confirmed booking starts."
          error={field("booking.cancellationWindowMin")}
        />
        <DurationPicker
          id="s-notice"
          legend="Booked at least"
          unit="min"
          max={10080}
          presets={DURATION_PRESETS.notice}
          value={form.minNoticeMin}
          onChange={(v) => set("minNoticeMin", v)}
          hint="Ahead of the time, online. You can still book it yourself."
          error={field("booking.minNoticeMin")}
        />
        <DurationPicker
          id="s-expire"
          legend="Requests nobody answers expire after"
          unit="h"
          min={1}
          presets={DURATION_PRESETS.holdHours}
          value={form.autoExpireHours}
          onChange={(v) => set("autoExpireHours", v)}
          error={field("booking.autoExpireHours")}
        />
        <Field
          id="s-late"
          label="A cancellation after that"
          error={field("booking.lateCancellation")}
          hint="Late ones are kept on the record."
        >
          <select
            id="s-late"
            className="input"
            value={form.lateCancellation}
            onChange={(e) => set("lateCancellation", e.target.value === "refuse" ? "refuse" : "record")}
          >
            <option value="record">Take it, marked late</option>
            <option value="refuse">Refuse it, and send them to you</option>
          </select>
        </Field>
      </div>
    </section>
  );
}

// ---- advanced -------------------------------------------------------------------------------

/** Everything else, folded until asked for. */
function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="card glass advanced">
      <summary className="disclosure">
        <ChevronRight className="icon-sm disclosure-icon" aria-hidden="true" />
        <span className="disclosure-open">Fewer options</span>
        <span className="disclosure-closed">Advanced</span>
      </summary>
      <div className="stack advanced-body">{children}</div>
    </details>
  );
}

function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="subsection" aria-label={title}>
      <h4 className="subsec">{title}</h4>
      {children}
    </section>
  );
}

function AdvancedSections({
  form,
  set,
  field,
  listField,
  held,
  hosted,
  currency,
  timezone,
  sources,
  home,
}: {
  form: SettingsFormState;
  set: SetForm;
  field: (path: string) => string | undefined;
  listField: (path: string) => string | undefined;
  held: (path: string) => boolean;
  hosted: boolean;
  currency: string;
  timezone: string;
  sources: SettingsDoc["doc"]["setup"]["sources"];
  home: Profile["home"];
}) {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void session().then((u) => live && setEmail(u?.email ?? null));
    return () => {
      live = false;
    };
  }, []);
  const zoneCountry = countryOfZone(timezone);
  return (
    <>
      <SubSection title="More on bookings">
        <div className="grid2">
          <DurationPicker
            id="s-complete"
            legend="Counted as done after"
            unit="h"
            min={1}
            max={168}
            presets={DURATION_PRESETS.completeHours}
            value={form.autoCompleteHours}
            onChange={(v) => set("autoCompleteHours", v)}
            hint="Once it ends: time to mark a no-show."
            error={field("booking.autoCompleteHours")}
          />
          <Stepper
            id="s-holds"
            label="Times held per customer"
            min={0}
            max={10}
            value={form.maxHolds}
            onChange={(v) => set("maxHolds", v)}
            hint="Proposed times kept for them at once."
            error={field("booking.maxHolds")}
          />
          <div className="wide">
            <Switch checked={form.holdOnPropose} onChange={(v) => set("holdOnPropose", v)}>
              Hold a time you propose until they answer
            </Switch>
          </div>
        </div>
      </SubSection>

      <SubSection title="Requests for a price">
        <div className="grid2">
          <DurationPicker
            id="s-offer-hours"
            legend="What you propose holds for"
            unit="h"
            min={1}
            max={2160}
            presets={DURATION_PRESETS.holdHours}
            value={form.offerValidHours}
            onChange={(v) => set("offerValidHours", v)}
            error={field("negotiation.offerValidHours")}
          />
          <DurationPicker
            id="s-counter-hours"
            legend={hosted ? "Unanswered requests lapse after" : "Unanswered orders and requests lapse after"}
            unit="h"
            min={1}
            max={2160}
            presets={DURATION_PRESETS.holdHours}
            value={form.counterValidHours}
            onChange={(v) => set("counterValidHours", v)}
            error={field("negotiation.counterValidHours")}
          />
          <Stepper
            id="s-rounds"
            label="Back and forth before you answer"
            min={1}
            max={10}
            value={form.maxRounds}
            onChange={(v) => set("maxRounds", v)}
            hint="Then it comes to you."
            error={field("negotiation.maxRounds")}
          />
          <div className="wide">
            <Switch checked={form.binding} onChange={(v) => set("binding", v)}>
              What I propose binds me until it lapses
            </Switch>
          </div>
        </div>
      </SubSection>

      <SubSection title="Prices, and what your AI may agree to">
        <div className="grid2">
          <div className="wide">
            <Switch checked={form.priceCounters} onChange={(v) => set("priceCounters", v)}>
              Customers may suggest a price of their own
            </Switch>
          </div>
          <Stepper
            id="s-ai-discount"
            label="Discount your AI may give"
            min={0}
            max={50}
            suffix="%"
            value={form.aiDiscountPct}
            onChange={(v) => set("aiDiscountPct", v)}
            hint="Never under your lowest price."
            error={field("negotiation.ai.maxDiscountPct")}
          />
          <DurationPicker
            id="s-ai-shift"
            legend="Another time it may propose, within"
            unit="h"
            max={720}
            presets={DURATION_PRESETS.shiftHours}
            value={form.aiTimeShiftHours}
            onChange={(v) => set("aiTimeShiftHours", v)}
            hint="Of the time asked for. Always a free time."
            error={field("negotiation.ai.maxTimeShiftMin")}
          />
          {!hosted && (
            <DurationPicker
              id="s-ai-delay"
              legend="Delivery later than asked, up to"
              unit="days"
              max={90}
              presets={DURATION_PRESETS.delayDays}
              value={form.aiDelayDays}
              onChange={(v) => set("aiDelayDays", v)}
              error={field("negotiation.ai.maxDelayDays")}
            />
          )}
          {!hosted && (
            <Field
              id="s-ai-refund"
              label="Refund it may agree with nothing sent back"
              optional
              error={field("negotiation.ai.maxRefundMinor")}
              hint="Per order."
            >
              <MoneyInput
                id="s-ai-refund"
                currency={currency}
                placeholder="Never"
                value={form.aiRefundMax}
                onChange={(v) => set("aiRefundMax", v)}
              />
            </Field>
          )}
          <div className="wide">
            <Switch checked={form.aiPricesCustom} onChange={(v) => set("aiPricesCustom", v)}>
              My AI may price what my list does not
            </Switch>
          </div>
        </div>
      </SubSection>

      <SubSection title="Changes to what was agreed">
        <div className="grid2">
          <Stepper
            id="s-changes"
            label={hosted ? "Changes per booking" : "Changes per booking or order"}
            min={0}
            max={3}
            value={form.maxChanges}
            onChange={(v) => set("maxChanges", v)}
            error={field("negotiation.changes.maxPerItem")}
          />
          <DurationPicker
            id="s-change-cutoff"
            legend="Only you accept a change from"
            unit="min"
            presets={DURATION_PRESETS.cutoff}
            value={form.changeCutoffMin}
            onChange={(v) => set("changeCutoffMin", v)}
            hint="Before the booking."
            error={field("negotiation.changes.customerCutoffMin")}
          />
          <div className="wide">
            <Switch checked={form.aiAcceptsChanges} onChange={(v) => set("aiAcceptsChanges", v)}>
              My AI may accept a customer's change
            </Switch>
          </div>
          <div className="wide">
            <Switch checked={form.aiProposesChanges} onChange={(v) => set("aiProposesChanges", v)}>
              My AI may ask customers for a change
            </Switch>
          </div>
        </div>
      </SubSection>

      {!hosted && (
        <SubSection title="Orders and returns">
          <div className="grid2">
            <Field
              id="s-limit"
              label="Orders above this wait for you"
              optional
              error={field("orders.maxValueWithoutApprovalMinor")}
            >
              <MoneyInput
                id="s-limit"
                currency={currency}
                placeholder="No limit"
                value={form.approvalLimit}
                onChange={(v) => set("approvalLimit", v)}
              />
            </Field>
            <DurationPicker
              id="s-pay"
              legend="Unpaid orders lapse after"
              unit="days"
              min={1}
              max={90}
              presets={DURATION_PRESETS.orderDays}
              value={form.payDays}
              onChange={(v) => set("payDays", v)}
              error={field("orders.payDays")}
            />
            <DurationPicker
              id="s-due"
              legend="Orders are due within"
              unit="days"
              min={1}
              max={365}
              presets={DURATION_PRESETS.orderDays}
              value={form.dueDays}
              onChange={(v) => set("dueDays", v)}
              hint="When none was asked for."
              error={field("orders.dueDays")}
            />
            <DurationPicker
              id="s-return-days"
              legend="Days to change their mind"
              unit="days"
              min={14}
              max={365}
              presets={DURATION_PRESETS.returnDays}
              value={form.returnDays}
              onChange={(v) => set("returnDays", v)}
              hint="14 at least, by law."
              error={field("returns.days")}
            />
            <Stepper
              id="s-refund-days"
              label="You refund within"
              suffix="days"
              min={1}
              max={14}
              value={form.refundDays}
              onChange={(v) => set("refundDays", v)}
              error={field("returns.refundDays")}
            />
            <DurationPicker
              id="s-respond"
              legend="You answer a return within"
              unit="h"
              min={1}
              max={336}
              presets={DURATION_PRESETS.respondHours}
              value={form.respondHours}
              onChange={(v) => set("respondHours", v)}
              error={field("returns.respondHours")}
            />
            <Field id="s-postage" label="Sending back is paid by" error={field("returns.postage")}>
              <select
                id="s-postage"
                className="input"
                value={form.returnPostage}
                onChange={(e) => set("returnPostage", e.target.value === "business" ? "business" : "customer")}
              >
                <option value="customer">The customer</option>
                <option value="business">You</option>
              </select>
            </Field>
            <Field id="s-sells-to" label="You sell to" error={field("commerce.customers")}>
              <select
                id="s-sells-to"
                className="input"
                value={form.sellsTo}
                onChange={(e) =>
                  set(
                    "sellsTo",
                    e.target.value === "businesses"
                      ? "businesses"
                      : e.target.value === "consumers"
                        ? "consumers"
                        : "both",
                  )
                }
              >
                <option value="both">Anyone</option>
                <option value="consumers">Consumers</option>
                <option value="businesses">Businesses only</option>
              </select>
            </Field>
            <div className="wide">
              <Switch checked={form.aiApprovesReturns} onChange={(v) => set("aiApprovesReturns", v)}>
                My AI may approve a return inside my policy
              </Switch>
            </div>
          </div>
        </SubSection>
      )}

      <SubSection title="Who you are">
        <div className="grid2">
          <Field id="s-legal-name" label="Legal name" optional error={field("commerce.legal.legalName")}>
            <input
              id="s-legal-name"
              className="input"
              value={form.legalName}
              onChange={(e) => set("legalName", e.target.value)}
            />
          </Field>
          <div>
            <div className="label-line">
              <label className="label" htmlFor="s-legal-country">
                Country
              </label>
              <SourceTag source={sourceNote(sources, "commerce.legal.country")} />
            </div>
            <CountrySelect
              id="s-legal-country"
              value={form.legalCountry}
              suggest={zoneCountry}
              onChange={(v) => set("legalCountry", v)}
            />
            {field("commerce.legal.country") ? (
              <div className="hint error" role="alert">
                {field("commerce.legal.country")}
              </div>
            ) : (
              <div className="hint">Its consumer law, words and holidays.</div>
            )}
          </div>
          <Field id="s-vat" label="VAT number" optional error={field("commerce.legal.vatId")}>
            <input id="s-vat" className="input" value={form.vatId} onChange={(e) => set("vatId", e.target.value)} />
          </Field>
          {!hosted && (
            <>
              <Field id="s-legal-address" label="Address" optional error={field("commerce.legal.address")}>
                <input
                  id="s-legal-address"
                  className="input"
                  value={form.legalAddress}
                  onChange={(e) => set("legalAddress", e.target.value)}
                />
              </Field>
              <Field id="s-legal-email" label="Email" optional error={field("commerce.legal.email")}>
                <input
                  id="s-legal-email"
                  className="input"
                  type="email"
                  value={form.legalEmail}
                  onChange={(e) => set("legalEmail", e.target.value)}
                />
              </Field>
              <Field id="s-legal-phone" label="Phone" optional error={field("commerce.legal.phone")}>
                <input
                  id="s-legal-phone"
                  className="input"
                  type="tel"
                  value={form.legalPhone}
                  onChange={(e) => set("legalPhone", e.target.value)}
                />
              </Field>
              <Field
                id="s-complaints"
                label="Where customers can complain"
                optional
                error={field("commerce.legal.complaintsUrl")}
                hint={
                  form.legalCountry === "PT"
                    ? "Your Livro de Reclamações page."
                    : "A web address where customers can complain."
                }
              >
                <input
                  id="s-complaints"
                  className="input"
                  type="url"
                  value={form.complaintsUrl}
                  onChange={(e) => set("complaintsUrl", e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      </SubSection>

      <SubSection title="Notifications and email">
        {held("email") && held("notifications.ownerEmail") ? (
          <HeldList
            rows={[
              ["Tell me at", form.ownerEmail || email || ""],
              ["Inbox address", home && !home.linked ? "Not connected yet" : form.appUrl.replace(/^https:\/\//, "")],
              ["Sends as", form.fromName],
            ]}
          />
        ) : (
          <div className="grid2">
            <Field
              id="s-owner-email"
              label="Tell me at"
              optional
              error={field("notifications.ownerEmail")}
              hint={email ? `Empty: ${email}.` : "Empty: the address you sign in with."}
            >
              <input
                id="s-owner-email"
                className="input"
                type="email"
                placeholder={email ?? ""}
                value={form.ownerEmail}
                onChange={(e) => set("ownerEmail", e.target.value)}
              />
            </Field>
            <Field
              id="s-app-url"
              label="Inbox address"
              optional
              error={field("notifications.appUrl")}
              hint="In email links and receipts."
            >
              <input
                id="s-app-url"
                className="input"
                readOnly={held("notifications.appUrl")}
                type="url"
                placeholder="https://inbox.example.com"
                value={form.appUrl}
                onChange={(e) => set("appUrl", e.target.value)}
              />
            </Field>
            <Field
              id="s-from"
              label="Send from"
              optional
              error={field("email.fromAddress")}
              hint={form.fromAddress.trim() ? "In your name." : "Without one, emails are not sent."}
            >
              <input
                id="s-from"
                className="input"
                type="email"
                value={form.fromAddress}
                onChange={(e) => set("fromAddress", e.target.value)}
              />
            </Field>
            <Field id="s-from-name" label="Sender name" optional error={field("email.fromName")}>
              <input
                id="s-from-name"
                className="input"
                value={form.fromName}
                onChange={(e) => set("fromName", e.target.value)}
              />
            </Field>
            <Field
              id="s-reply"
              label="Customers reply to"
              optional
              error={field("email.replyTo")}
              hint="Usually the business mailbox."
            >
              <input
                id="s-reply"
                className="input"
                type="email"
                value={form.replyTo}
                onChange={(e) => set("replyTo", e.target.value)}
              />
            </Field>
            <Field
              id="s-inbound"
              label="Inbound email secret"
              optional
              error={field("email.inboundSecret")}
              hint={form.inboundSecretSet ? "Set. Type a new one to replace it." : "16 characters at least."}
            >
              <input
                id="s-inbound"
                className="input"
                autoComplete="off"
                spellCheck={false}
                placeholder={form.inboundSecretSet ? "Set" : ""}
                value={form.inboundSecret}
                onChange={(e) => set("inboundSecret", e.target.value)}
              />
            </Field>
            {form.inboundSecretSet && (
              <div className="wide">
                <Switch checked={form.removeInboundSecret} onChange={(v) => set("removeInboundSecret", v)}>
                  Remove the inbound email secret
                </Switch>
              </div>
            )}
          </div>
        )}
      </SubSection>

      <SubSection title="Customers you already know">
        <div className="grid2">
          <div className="wide">
            <Switch checked={form.emailKey} onChange={(v) => set("emailKey", v)}>
              Send a new customer a code for their assistant
            </Switch>
            <div className="hint">A day after their first booking, in your name.</div>
          </div>
          {!hosted && (
            <>
              <DurationPicker
                id="s-code-minutes"
                legend="A code works for"
                unit="min"
                min={1}
                max={60}
                presets={DURATION_PRESETS.codeMinutes}
                value={form.codeMinutes}
                onChange={(v) => set("codeMinutes", v)}
                error={field("customers.otp.ttlMinutes")}
              />
              <Stepper
                id="s-code-tries"
                label="Wrong tries per code"
                min={1}
                max={10}
                value={form.codeAttempts}
                onChange={(v) => set("codeAttempts", v)}
                error={field("customers.otp.attempts")}
              />
              <Stepper
                id="s-code-sends"
                label="Codes to one address an hour"
                min={1}
                max={10}
                value={form.codesPerHour}
                onChange={(v) => set("codesPerHour", v)}
                error={field("customers.otp.sendsPerHour")}
              />
              <Stepper
                id="s-code-sends-day"
                label="Codes to one address a day"
                min={1}
                max={50}
                value={form.codesPerDay}
                onChange={(v) => set("codesPerDay", v)}
                error={field("customers.otp.sendsPerDay")}
              />
              <Stepper
                id="s-code-tries-day"
                label="Tries at a code a day"
                min={1}
                max={100}
                value={form.triesPerDay}
                onChange={(v) => set("triesPerDay", v)}
                error={field("customers.otp.guessesPerDay")}
              />
              <Field
                id="s-hosts"
                label="Other addresses of this inbox"
                optional
                error={listField("identity.extraAuthorities")}
                hint="Like an old domain, comma-separated. Usually empty."
              >
                <input
                  id="s-hosts"
                  className="input"
                  readOnly={held("identity.extraAuthorities")}
                  spellCheck={false}
                  autoCapitalize="none"
                  placeholder="old.example.com"
                  value={form.extraHosts}
                  onChange={(e) => set("extraHosts", e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      </SubSection>

      {!hosted && (
        <SubSection title="Receipts">
          <ReceiptsStatus />
        </SubSection>
      )}

      <SubSection title="Testing">
        <Switch checked={form.testMode} onChange={(v) => set("testMode", v)}>
          Test mode
        </Switch>
        <div className="hint">New items are sandbox items, and the inbox shows only those.</div>
      </SubSection>
    </>
  );
}

/** Settings the host holds, shown as they are. */
function HeldList({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="held-list">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/**
 * Whether this instance signs receipts, and what it has signed. Nothing here is a setting: the two
 * values that gate it are environment variables, and this says which one is missing.
 */
function ReceiptsStatus() {
  const q = useReceiptStatus();
  if (q.isPending) return <div className="hint">Checking…</div>;
  if (q.isError) return <div className="hint">Could not read the receipt status.</div>;
  const r = q.data;
  return (
    <div className="stack">
      {r.ready ? (
        <div className="hint">
          Signed as <span className="mono">{r.issuer}</span>: {r.issued} issued, {r.acknowledged} counter-signed.
        </div>
      ) : (
        <div className="hint">Not issuing receipts. {r.reason}</div>
      )}
    </div>
  );
}
