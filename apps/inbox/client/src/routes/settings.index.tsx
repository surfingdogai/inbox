import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { CountrySelect, CurrencySelect, LanguagePicker, SourceTag, TimeZoneSelect } from "../components/Choosers";
import { DownloadInbox } from "../components/DownloadInbox";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, Switch } from "../components/Form";
import { problemOf } from "../lib/api";
import { currencyNote } from "../lib/currencies";
import { doorSwitchDoc, doorViews, needsWords } from "../lib/doors";
import { emailLangOf, mailBannerLines } from "../lib/format";
import { languagesToSave } from "../lib/languages";
import {
  qk,
  useAvailability,
  useMailStatus,
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

/** A settings write the page makes on its own (a switch, the description), and what comes of it. */
type PatchSettings = (doc: Record<string, unknown>, done?: () => void) => void;

/**
 * What agents can do, who the business is (its own row) and the settings document (versioned), each
 * saved on its own. The switches and the description write small patches to the settings while the
 * long form below may hold edits: the form follows those versions (its own page's writes), so its
 * save is not refused as a change made somewhere else, and a change truly made elsewhere still is.
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
      {profile.isPending && <Loading />}
      {profile.isError && (
        <div className="card glass">
          <ErrorState
            title="Could not load the business profile"
            text={problemOf(profile.error).detail}
            onRetry={() => void profile.refetch()}
          />
        </div>
      )}
      {profile.data && settings.data && (
        <ProfileForm
          key={`${JSON.stringify({ ...profile.data, item_types: null })}|${settings.data.doc.directory.description}|${JSON.stringify(settings.data.doc.setup.sources)}`}
          initial={profile.data}
          settings={settings.data.doc}
          onPatch={patchSettings}
          onSaved={() => setSaved("Business saved.")}
        />
      )}
      {settings.isPending && <Loading />}
      {settings.isError && (
        <div className="card glass">
          <ErrorState
            title="Could not load the settings"
            text={problemOf(settings.error).detail}
            onRetry={() => void settings.refetch()}
          />
        </div>
      )}
      {settings.data && (
        <SettingsForm
          key={formKey}
          initial={settings.data}
          expectedVersion={expectedFor}
          onSaved={() => {
            setSaved("Settings saved.");
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
 * What is wrong with email, when something is: no mail service (every email only goes to the log and
 * shows as not sent), no address to send from, or no links in the emails. Nothing when all is well.
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
 * Three switches, one line each. A booking switched on waits for a service and opening hours, and
 * says so with the way there; bookings taken at another site say where, and can come back here.
 */
function DoorsCard({ doc, pending, onPatch }: { doc: SettingsDoc["doc"]; pending: boolean; onPatch: PatchSettings }) {
  // The owner's own read of the doors: the public one answers no agent until the inbox is connected.
  const profile = useProfile();
  const services = useServices();
  const availability = useAvailability();
  if (!profile.data) return null;
  const a = availability.data;
  const windows = (w: object | undefined) => Object.values(w ?? {}).some((d) => Array.isArray(d) && d.length > 0);
  const views = doorViews({
    doors: doc.doors,
    itemTypes: profile.data.item_types,
    hasService: (services.data?.items ?? []).some((s) => s.active === 1),
    hasHours: Boolean(a && ((a.weekly_set && windows(a.weekly)) || a.overrides.some((o) => windows(o.weekly)))),
    doorsElsewhere: doc.doorsElsewhere,
  });
  return (
    <section className="card glass doors" aria-labelledby="doors-title">
      <h3 className="sec" id="doors-title">
        What agents can do
      </h3>
      <ul className="door-list">
        {views.map((v) => (
          <li key={v.key} className="door-row">
            <Switch
              checked={v.on}
              disabled={pending || Boolean(v.elsewhere)}
              onChange={(on) => onPatch(doorSwitchDoc(v.key, on))}
            >
              {v.label}
            </Switch>
            {v.needs && (
              <span className="door-note">
                {needsWords(v.needs)} {v.needs !== "hours" && <Link to="/settings/services">Add a service</Link>}
                {v.needs === "service_and_hours" && " · "}
                {v.needs !== "service" && <Link to="/settings/availability">Set hours</Link>}
              </span>
            )}
            {v.elsewhere && (
              <span className="door-note">
                Booked at {v.elsewhere}.{" "}
                <button
                  type="button"
                  className="linkish"
                  disabled={pending}
                  onClick={() =>
                    onPatch({ doorsElsewhere: doc.doorsElsewhere.filter((d) => d.itemType !== "booking") })
                  }
                >
                  Take bookings here
                </button>
              </span>
            )}
            {v.key === "message" && !v.on && <span className="door-note">Email still reaches you.</span>}
          </li>
        ))}
      </ul>
      {views.every((v) => !v.open) && <p className="hint">Agents can't reach you at all.</p>}
    </section>
  );
}

// ---- the business row ---------------------------------------------------------------------

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

function ProfileForm({
  initial,
  settings,
  onPatch,
  onSaved,
}: {
  initial: Profile;
  settings: SettingsDoc["doc"];
  onPatch: PatchSettings;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ProfileDraft>({
    name: initial.name,
    description: settings.directory.description,
    domain: initial.domain ?? "",
    timezone: initial.timezone,
    currency: initial.currency,
    emailLang: emailLangOf(initial.languages),
    languages: [...initial.languages],
  });
  const save = useSaveProfile();
  const services = useServices();
  const products = useProducts();
  const problem = save.error ? problemOf(save.error) : null;
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const sources = settings.setup.sources;
  const held = initial.domain_held;
  const prices = [
    ...(services.data?.items ?? []).flatMap((s) =>
      s.price && s.price.model !== "quote" && s.price.value !== undefined ? [{ currency: s.price.currency }] : [],
    ),
    ...(products.data?.items ?? []).map((p) => ({ currency: p.price.currency })),
  ];
  const note = currencyNote(form.currency, initial.currency, prices);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const name = form.name.trim();
    save.mutate(
      {
        // An empty name is left as it is, so the rest can still be saved.
        ...(name ? { name } : {}),
        ...(held ? {} : { domain: form.domain.trim() ? form.domain.trim().toLowerCase() : null }),
        timezone: form.timezone,
        currency: form.currency,
        // Reordered only when the email language changed: the business's own order is kept.
        languages: languagesToSave(form.languages, form.emailLang, form.emailLang !== emailLangOf(initial.languages)),
      },
      {
        onSuccess: () => {
          const description = form.description.trim();
          const doc: Record<string, unknown> = {
            ...(description !== settings.directory.description ? { directory: { description } } : {}),
            ...(clearSources(
              sources,
              "profile.name",
              "profile.currency",
              "profile.languages",
              "profile.timezone",
              "directory.description",
            ) ?? {}),
          };
          if (Object.keys(doc).length) onPatch(doc, onSaved);
          else onSaved();
        },
      },
    );
  };
  return (
    <form className="card glass stack" onSubmit={submit}>
      <h3 className="sec">Business</h3>
      {problem && !problem.fields?.length && (
        <Toast tone="danger" text="The business was not saved." sub={problem.detail} />
      )}
      <div className="settings-grid">
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
            value={form.name}
            autoComplete="organization"
            onChange={(e) => set("name", e.target.value)}
          />
          {problem?.field("name") ? (
            <div className="hint error" role="alert">
              {problem.field("name")}
            </div>
          ) : (
            !form.name.trim() && <div className="hint">Agents and customers see it.</div>
          )}
        </div>
        <Field
          id="p-domain"
          label="Website"
          optional={!held}
          error={problem?.field("domain")}
          hint={
            held
              ? form.domain
                ? "Set by your host."
                : "Your host sets it once your website links to your inbox."
              : "Where agents find you, like example.com."
          }
        >
          <input
            id="p-domain"
            className="input"
            inputMode="url"
            spellCheck={false}
            readOnly={held}
            aria-readonly={held || undefined}
            placeholder={held ? "Not linked yet" : "example.com"}
            value={form.domain}
            onChange={(e) => set("domain", e.target.value)}
          />
        </Field>
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
            className="input"
            rows={2}
            maxLength={DESCRIPTION_MAX}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
          <div className="hint count">
            A sentence or two, in public. {form.description.length}/{DESCRIPTION_MAX}
          </div>
        </div>
        <Field id="p-tz" label="Time zone" error={problem?.field("timezone")} hint="Hours and bookings are in it.">
          <TimeZoneSelect id="p-tz" value={form.timezone} onChange={(v) => set("timezone", v)} />
        </Field>
        <div>
          <div className="label-line">
            <label className="label" htmlFor="p-currency">
              Currency
            </label>
            <SourceTag source={sourceNote(sources, "profile.currency")} />
          </div>
          <CurrencySelect id="p-currency" value={form.currency} onChange={(v) => set("currency", v)} />
          {problem?.field("currency") ? (
            <div className="hint error" role="alert">
              {problem.field("currency")}
            </div>
          ) : (
            note && <div className="hint">{note}</div>
          )}
        </div>
        <div className="wide">
          <div className="label-line">
            <label className="label" htmlFor="p-langs">
              Languages you speak
            </label>
            <SourceTag source={sourceNote(sources, "profile.languages")} />
          </div>
          <LanguagePicker id="p-langs" value={form.languages} onChange={(v) => set("languages", v)} />
          {problem?.field("languages") && (
            <div className="hint error" role="alert">
              {problem.field("languages")}
            </div>
          )}
        </div>
        <Field id="p-email-lang" label="Customers' emails are in" hint="Unless their assistant asks for the other one.">
          <select
            id="p-email-lang"
            className="input"
            value={form.emailLang}
            onChange={(e) => set("emailLang", e.target.value === "pt" ? "pt" : "en")}
          >
            <option value="en">English</option>
            <option value="pt">Português</option>
          </select>
        </Field>
      </div>
      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending && <span className="spinner" aria-hidden="true" />}
          Save business
        </button>
      </div>
    </form>
  );
}

// ---- the settings document ------------------------------------------------------------------
// The form and what a save sends live in lib/settings.ts, where they are tested.

function SettingsForm({
  initial,
  expectedVersion,
  onSaved,
  onReload,
}: {
  initial: SettingsDoc;
  /** The version a save is made against, from the one the form was opened at (`GeneralPage`). */
  expectedVersion: (loaded: number) => number;
  onSaved: () => void;
  onReload: () => void;
}) {
  const [form, setForm] = useState<SettingsFormState>(() => toSettingsForm(initial.doc, initial.redacted ?? []));
  const [loaded] = useState(initial.version);
  const locked = initial.locked ?? [];
  /** Whether the host holds this setting: shown as it is, never changed here. */
  const held = (path: string) => locked.some((l) => path === l || path.startsWith(`${l}.`));
  const save = useSaveSettings();
  const problem = save.error ? problemOf(save.error) : null;
  const conflict = problem?.code === "version_conflict";
  const set = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const field = (path: string) => problem?.field(path);
  // A list's error names the entry ("identity.extraAuthorities.1"): shown on the list's one field.
  const listField = (path: string) => field(path) ?? problem?.fields?.find((f) => f.path.includes(`${path}.`))?.message;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    save.mutate({ doc: toSettingsDoc(form), expected_version: expectedVersion(loaded) }, { onSuccess: onSaved });
  };

  return (
    <form className="stack" onSubmit={submit}>
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
        <Toast tone="danger" text="The settings were not saved." sub={problem.detail} />
      )}

      <section className="card glass">
        <h3 className="sec">Bookings and orders</h3>
        <div className="settings-grid">
          <Field
            id="s-cancel"
            label="Cancellation window (minutes)"
            error={field("booking.cancellationWindowMin")}
            hint="Customers can cancel a confirmed booking until this long before it starts."
          >
            <input
              id="s-cancel"
              className="input"
              type="number"
              min={0}
              step={1}
              value={form.cancellationWindowMin}
              onChange={(e) => set("cancellationWindowMin", e.target.value)}
            />
          </Field>
          <Field
            id="s-notice"
            label="Minimum notice (minutes)"
            error={field("booking.minNoticeMin")}
            hint="Customers can no longer book a time online this close to it. You can still book it yourself; nobody books a time that has started."
          >
            <input
              id="s-notice"
              className="input"
              type="number"
              min={0}
              max={10080}
              step={1}
              value={form.minNoticeMin}
              onChange={(e) => set("minNoticeMin", e.target.value)}
            />
          </Field>
          <Field
            id="s-expire"
            label="Auto-expire after (hours)"
            error={field("booking.autoExpireHours")}
            hint="Requests nobody answered expire after this long."
          >
            <input
              id="s-expire"
              className="input"
              type="number"
              min={1}
              step={1}
              value={form.autoExpireHours}
              onChange={(e) => set("autoExpireHours", e.target.value)}
            />
          </Field>
          <Field
            id="s-limit"
            label="Order approval limit"
            optional
            error={field("orders.maxValueWithoutApprovalMinor")}
            hint="Orders above this amount are for a person to approve; empty means no limit."
          >
            <input
              id="s-limit"
              className="input"
              inputMode="decimal"
              value={form.approvalLimit}
              onChange={(e) => set("approvalLimit", e.target.value)}
            />
          </Field>
          <Field
            id="s-late"
            label="After the cancellation window"
            error={field("booking.lateCancellation")}
            hint="Record a late cancellation, or refuse it and send the customer to you. Networks weigh one only when it comes under 48 hours before the start."
          >
            <select
              id="s-late"
              className="input"
              value={form.lateCancellation}
              onChange={(e) => set("lateCancellation", e.target.value === "refuse" ? "refuse" : "record")}
            >
              <option value="record">Take it, recorded as late</option>
              <option value="refuse">Refuse it</option>
            </select>
          </Field>
          <Field
            id="s-complete"
            label="Completed automatically after (hours)"
            error={field("booking.autoCompleteHours")}
            hint="After a confirmed booking ends, this long for you to mark a no-show; then it counts as completed. Either can be corrected once until then."
          >
            <input
              id="s-complete"
              className="input"
              type="number"
              min={1}
              max={168}
              step={1}
              value={form.autoCompleteHours}
              onChange={(e) => set("autoCompleteHours", e.target.value)}
            />
          </Field>
          <Field
            id="s-pay"
            label="Unpaid orders lapse after (days)"
            error={field("orders.payDays")}
            hint="Days after you ask for payment. The order stays open for you; networks see it closed, counted against nobody."
          >
            <input
              id="s-pay"
              className="input"
              type="number"
              min={1}
              max={90}
              step={1}
              value={form.payDays}
              onChange={(e) => set("payDays", e.target.value)}
            />
          </Field>
          <Field
            id="s-due"
            label="Orders are due within (days)"
            error={field("orders.dueDays")}
            hint="For an order with no delivery time: when networks expect it fulfilled, counted from when you accepted it."
          >
            <input
              id="s-due"
              className="input"
              type="number"
              min={1}
              max={365}
              step={1}
              value={form.dueDays}
              onChange={(e) => set("dueDays", e.target.value)}
            />
          </Field>
          <div className="wide">
            <Switch checked={form.holdOnPropose} onChange={(v) => set("holdOnPropose", v)}>
              Hold the slot while a proposed time is pending
            </Switch>
          </div>
          <Field
            id="s-holds"
            label="Times held per customer"
            error={field("booking.maxHolds")}
            hint="At most this many proposed times held at once for one customer; past it a time goes out unheld, theirs if still free."
          >
            <input
              id="s-holds"
              className="input"
              type="number"
              min={0}
              max={10}
              step={1}
              value={form.maxHolds}
              onChange={(e) => set("maxHolds", e.target.value)}
            />
          </Field>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Offers and answers</h3>
        <div className="settings-grid">
          <Field
            id="s-offer-hours"
            label="What you propose holds for (hours)"
            error={field("negotiation.offerValidHours")}
            hint="A quote or changes to an order sent without a date. What your AI or a rule proposes holds at most this long. A time you propose holds until its start, less the minimum notice."
          >
            <input
              id="s-offer-hours"
              className="input"
              type="number"
              min={1}
              max={2160}
              step={1}
              value={form.offerValidHours}
              onChange={(e) => set("offerValidHours", e.target.value)}
            />
          </Field>
          <Field
            id="s-counter-hours"
            label="Orders and quote requests lapse after (hours)"
            error={field("negotiation.counterValidHours")}
            hint="An order or a quote request nobody answered, after it came in or the customer last answered; the customer is told."
          >
            <input
              id="s-counter-hours"
              className="input"
              type="number"
              min={1}
              max={2160}
              step={1}
              value={form.counterValidHours}
              onChange={(e) => set("counterValidHours", e.target.value)}
            />
          </Field>
          <Field
            id="s-rounds"
            label="Rounds before you answer yourself"
            error={field("negotiation.maxRounds")}
            hint="Back and forth on one request. Past it your AI and rules propose nothing more, and a customer's next suggestion comes to you as their message."
          >
            <input
              id="s-rounds"
              className="input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={form.maxRounds}
              onChange={(e) => set("maxRounds", e.target.value)}
            />
          </Field>
          <div className="wide">
            <Switch checked={form.binding} onChange={(v) => set("binding", v)}>
              What I propose binds me until it lapses
            </Switch>
            <div className="hint">
              Off, each time, quote or change says it is subject to your confirmation, and you can withdraw it before
              the customer answers.
            </div>
          </div>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Prices, and what your AI may agree to</h3>
        <div className="settings-grid">
          <div className="wide">
            <Switch checked={form.priceCounters} onChange={(v) => set("priceCounters", v)}>
              Customers may suggest a price of their own
            </Switch>
            <div className="hint">
              Off, a price they suggest comes to you as their message and what you proposed stands. On, it is their
              answer, for you to take or answer; your AI and rules take one only at or above your lowest price, never
              haggle.
            </div>
          </div>
          <Field
            id="s-ai-discount"
            label="Discount your AI and rules may give (%)"
            error={field("negotiation.ai.maxDiscountPct")}
            hint="Off the customer's price, never under the lowest price you set for a product or service. 0: none."
          >
            <input
              id="s-ai-discount"
              className="input"
              type="number"
              min={0}
              max={50}
              step={1}
              value={form.aiDiscountPct}
              onChange={(e) => set("aiDiscountPct", e.target.value)}
            />
          </Field>
          <Field
            id="s-ai-shift"
            label="How far from the time asked they may propose (hours)"
            error={field("negotiation.ai.maxTimeShiftMin")}
            hint="Always a free time. Further than this, what they would propose is kept as a draft for you."
          >
            <input
              id="s-ai-shift"
              className="input"
              type="number"
              min={0}
              max={720}
              step={1}
              value={form.aiTimeShiftHours}
              onChange={(e) => set("aiTimeShiftHours", e.target.value)}
            />
          </Field>
          <Field
            id="s-ai-delay"
            label="Days later than asked they may deliver"
            error={field("negotiation.ai.maxDelayDays")}
            hint="For changes to an order. 0: never later than the customer asked."
          >
            <input
              id="s-ai-delay"
              className="input"
              type="number"
              min={0}
              max={90}
              step={1}
              value={form.aiDelayDays}
              onChange={(e) => set("aiDelayDays", e.target.value)}
            />
          </Field>
          <Field
            id="s-ai-refund"
            label="Refund they may agree with nothing sent back, per order, up to"
            optional
            error={field("negotiation.ai.maxRefundMinor")}
            hint="Empty: never. Refunding itself is always yours, or your till's."
          >
            <input
              id="s-ai-refund"
              className="input"
              inputMode="decimal"
              value={form.aiRefundMax}
              onChange={(e) => set("aiRefundMax", e.target.value)}
            />
          </Field>
          <div className="wide">
            <Switch checked={form.aiPricesCustom} onChange={(v) => set("aiPricesCustom", v)}>
              My AI and rules may price what the catalogue does not
            </Switch>
            <div className="hint">
              A quote, a line of their own, a longer booking. Off, they draft it for you. Outside any of these limits
              nothing is sent: you find a draft on the item, to send as it is, change, or drop.
            </div>
          </div>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Changes to what was agreed</h3>
        <div className="settings-grid">
          <Field
            id="s-changes"
            label="Changes per booking or order"
            error={field("negotiation.changes.maxPerItem")}
            hint="Once agreed, at most this many (3 at most). Past it, a customer's request comes to you as their message."
          >
            <input
              id="s-changes"
              className="input"
              type="number"
              min={0}
              max={3}
              step={1}
              value={form.maxChanges}
              onChange={(e) => set("maxChanges", e.target.value)}
            />
          </Field>
          <Field
            id="s-change-cutoff"
            label="Customers' changes need you from (minutes before)"
            optional
            error={field("negotiation.changes.customerCutoffMin")}
            hint="After this, only you accept a customer's change to a booking, not your AI or a rule. Empty means the cancellation window."
          >
            <input
              id="s-change-cutoff"
              className="input"
              type="number"
              min={0}
              step={1}
              value={form.changeCutoffMin}
              onChange={(e) => set("changeCutoffMin", e.target.value)}
            />
          </Field>
          <div className="wide">
            <Switch checked={form.aiAcceptsChanges} onChange={(v) => set("aiAcceptsChanges", v)}>
              My AI and rules may accept a customer's change
            </Switch>
            <div className="hint">
              To a free time before the cutoff, at your prices; never one that changes a price.
            </div>
          </div>
          <div className="wide">
            <Switch checked={form.aiProposesChanges} onChange={(v) => set("aiProposesChanges", v)}>
              My AI and rules may ask customers for a change
            </Switch>
            <div className="hint">
              Another time, other quantities or a delivery date; if the customer says no, it stays as agreed.
            </div>
          </div>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Returns, and who you are</h3>
        <div className="settings-grid">
          <Field
            id="s-return-days"
            label="Days to change their mind"
            error={field("returns.days")}
            hint="From delivery, or from booking for a service they paid for. The law gives 14 at least; more is your own policy."
          >
            <input
              id="s-return-days"
              className="input"
              type="number"
              min={14}
              max={365}
              step={1}
              value={form.returnDays}
              onChange={(e) => set("returnDays", e.target.value)}
            />
          </Field>
          <Field
            id="s-postage"
            label="Sending things back is paid by"
            error={field("returns.postage")}
            hint="Faulty goods always come back at your cost."
          >
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
          <Field
            id="s-refund-days"
            label="You refund within (days)"
            error={field("returns.refundDays")}
            hint="Once nothing more has to come back; 14 at most. A withdrawal is refunded within 14 days of the customer's notice."
          >
            <input
              id="s-refund-days"
              className="input"
              type="number"
              min={1}
              max={14}
              step={1}
              value={form.refundDays}
              onChange={(e) => set("refundDays", e.target.value)}
            />
          </Field>
          <Field
            id="s-respond"
            label="You answer a return within (hours)"
            error={field("returns.respondHours")}
            hint="Customers are told this when they ask to send something back."
          >
            <input
              id="s-respond"
              className="input"
              type="number"
              min={1}
              max={336}
              step={1}
              value={form.respondHours}
              onChange={(e) => set("respondHours", e.target.value)}
            />
          </Field>
          <Field
            id="s-sells-to"
            label="You sell to"
            error={field("commerce.customers")}
            hint="Unless only businesses, customers confirm the price before they order, and may withdraw."
          >
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
              My AI and rules may approve a return inside my policy
            </Switch>
            <div className="hint">
              With the goods coming back; never paying a refund, refusing a return or keeping part.
            </div>
          </div>
          <Field
            id="s-legal-name"
            label="Legal name"
            optional
            error={field("commerce.legal.legalName")}
            hint="Every confirmation says who customers are buying from."
          >
            <input
              id="s-legal-name"
              className="input"
              value={form.legalName}
              onChange={(e) => set("legalName", e.target.value)}
            />
          </Field>
          <Field id="s-legal-address" label="Address" optional error={field("commerce.legal.address")}>
            <input
              id="s-legal-address"
              className="input"
              value={form.legalAddress}
              onChange={(e) => set("legalAddress", e.target.value)}
            />
          </Field>
          <Field
            id="s-legal-country"
            label="Country"
            optional
            error={field("commerce.legal.country")}
            hint="The consumer law you sell under, its words and its holidays."
          >
            <CountrySelect id="s-legal-country" value={form.legalCountry} onChange={(v) => set("legalCountry", v)} />
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
              value={form.legalPhone}
              onChange={(e) => set("legalPhone", e.target.value)}
            />
          </Field>
          <Field id="s-vat" label="VAT number" optional error={field("commerce.legal.vatId")}>
            <input id="s-vat" className="input" value={form.vatId} onChange={(e) => set("vatId", e.target.value)} />
          </Field>
          <Field
            id="s-complaints"
            label="Where customers can complain"
            optional
            error={field("commerce.legal.complaintsUrl")}
            hint="A web address; in Portugal, your Livro de Reclamações page. A refused return points to it."
          >
            <input
              id="s-complaints"
              className="input"
              type="url"
              value={form.complaintsUrl}
              onChange={(e) => set("complaintsUrl", e.target.value)}
            />
          </Field>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Notifications and email</h3>
        {held("email") && held("notifications.ownerEmail") && held("notifications.appUrl") ? (
          <HeldList
            rows={[
              ["Tell me at", form.ownerEmail || "The address you sign in with"],
              ["Inbox address", form.appUrl],
              ["Send from", form.fromAddress],
              ["Sender name", form.fromName],
              ["Customers reply to", form.replyTo],
            ]}
          />
        ) : (
          <div className="settings-grid">
            <Field
              id="s-owner-email"
              label="Tell me at"
              optional
              error={field("notifications.ownerEmail")}
              hint="Where new items and replies are announced. Empty means the address you sign in with."
            >
              <input
                id="s-owner-email"
                className="input"
                readOnly={held("notifications.ownerEmail")}
                type="email"
                value={form.ownerEmail}
                onChange={(e) => set("ownerEmail", e.target.value)}
              />
            </Field>
            <Field
              id="s-app-url"
              label="Inbox address"
              optional
              error={field("notifications.appUrl")}
              hint="Used in email links and receipts, like https://inbox.example.com. Filled in when you first sign in. Networks also know your inbox by it."
            >
              <input
                id="s-app-url"
                className="input"
                readOnly={held("notifications.appUrl")}
                type="url"
                value={form.appUrl}
                onChange={(e) => set("appUrl", e.target.value)}
              />
            </Field>
            <Field
              id="s-from"
              label="Send from"
              optional
              error={field("email.fromAddress")}
              hint={
                form.fromAddress.trim()
                  ? "Emails to your customers come from this address, in your name."
                  : "Emails to your customers come from this address. Without one they are not sent, unless your server has an address of its own; each item shows whether its emails went out."
              }
            >
              <input
                id="s-from"
                className="input"
                readOnly={held("email.fromAddress")}
                type="email"
                value={form.fromAddress}
                onChange={(e) => set("fromAddress", e.target.value)}
              />
            </Field>
            <Field id="s-from-name" label="Sender name" optional error={field("email.fromName")}>
              <input
                id="s-from-name"
                className="input"
                readOnly={held("email.fromName")}
                value={form.fromName}
                onChange={(e) => set("fromName", e.target.value)}
              />
            </Field>
            <Field
              id="s-reply"
              label="Customers reply to"
              optional
              error={field("email.replyTo")}
              hint={
                form.replyTo.trim() || form.inboundSecretSet || form.inboundSecret.trim()
                  ? "Usually the business mailbox."
                  : "Usually the business mailbox. Customers' replies do not reach you yet: set this, or inbound email below."
              }
            >
              <input
                id="s-reply"
                className="input"
                readOnly={held("email.replyTo")}
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
              hint={
                form.inboundSecretSet
                  ? "A secret is set. It is never shown again; type a new one to replace it, or leave this empty to keep it."
                  : "At least 16 characters; sent by your mail provider's webhook in X-Inbox-Email-Secret."
              }
            >
              <input
                id="s-inbound"
                className="input"
                readOnly={held("email.inboundSecret")}
                autoComplete="off"
                spellCheck={false}
                placeholder={form.inboundSecretSet ? "Set; type a new one to replace it" : ""}
                value={form.inboundSecret}
                onChange={(e) => set("inboundSecret", e.target.value)}
              />
            </Field>
            {form.inboundSecretSet && (
              <Switch checked={form.removeInboundSecret} onChange={(v) => set("removeInboundSecret", v)}>
                Remove the inbound email secret: inbound email stops until a new one is set
              </Switch>
            )}
          </div>
        )}
      </section>

      <section className="card glass">
        <h3 className="sec">Customers you already know</h3>
        <p className="hint">
          When someone gives the email of a customer you know and nothing proves it is them, their assistant can ask for
          a six-digit code sent to that address. Until the code comes back they are served as a new customer, never
          refused, and they see nothing of the other customer's bookings or orders.
        </p>
        <div className="settings-grid">
          <Field
            id="s-code-minutes"
            label="A code works for (minutes)"
            error={field("customers.otp.ttlMinutes")}
            hint="From 1 to 60."
          >
            <input
              id="s-code-minutes"
              className="input"
              type="number"
              min={1}
              max={60}
              step={1}
              value={form.codeMinutes}
              onChange={(e) => set("codeMinutes", e.target.value)}
            />
          </Field>
          <Field
            id="s-code-tries"
            label="Wrong tries per code"
            error={field("customers.otp.attempts")}
            hint="After these the code stops working; a new one can be asked for."
          >
            <input
              id="s-code-tries"
              className="input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={form.codeAttempts}
              onChange={(e) => set("codeAttempts", e.target.value)}
            />
          </Field>
          <Field
            id="s-code-sends"
            label="Codes to one address per hour"
            error={field("customers.otp.sendsPerHour")}
            hint="So nobody can fill a customer's mailbox with codes."
          >
            <input
              id="s-code-sends"
              className="input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={form.codesPerHour}
              onChange={(e) => set("codesPerHour", e.target.value)}
            />
          </Field>
          <Field
            id="s-code-sends-day"
            label="Codes to one address per day"
            error={field("customers.otp.sendsPerDay")}
            hint="From 1 to 50."
          >
            <input
              id="s-code-sends-day"
              className="input"
              type="number"
              min={1}
              max={50}
              step={1}
              value={form.codesPerDay}
              onChange={(e) => set("codesPerDay", e.target.value)}
            />
          </Field>
          <Field
            id="s-code-tries-day"
            label="Tries at a code per address per day"
            error={field("customers.otp.guessesPerDay")}
            hint="Right or wrong, over every code sent there, so nobody can guess their way in over the day."
          >
            <input
              id="s-code-tries-day"
              className="input"
              type="number"
              min={1}
              max={100}
              step={1}
              value={form.triesPerDay}
              onChange={(e) => set("triesPerDay", e.target.value)}
            />
          </Field>
          <Field
            id="s-hosts"
            label="Other addresses of this inbox"
            optional
            error={listField("identity.extraAuthorities")}
            hint={
              held("identity.extraAuthorities")
                ? "Set by your host."
                : "Hosts this inbox also answers on, like an old domain, comma-separated. An assistant's signature names the host it was made for; one made for these still counts. Usually empty."
            }
          >
            <input
              id="s-hosts"
              className="input"
              readOnly={held("identity.extraAuthorities")}
              spellCheck={false}
              autoCapitalize="none"
              placeholder={held("identity.extraAuthorities") ? "None" : "old.example.com"}
              value={form.extraHosts}
              onChange={(e) => set("extraHosts", e.target.value)}
            />
          </Field>
        </div>
        <Switch checked={form.emailKey} onChange={(v) => set("emailKey", v)}>
          Email a new customer a code for their assistant
        </Switch>
        <div className="hint">
          A day after their first booking or order, a short email of its own, in your name: the code, and one line with
          a link to a page on this inbox that explains the booking network. Off, no email of this inbox carries it; an
          assistant still gets what it needs when it books. A network that emails the code itself sends that email in
          your name whatever this says, and never gives the code to this inbox.
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Receipts</h3>
        <ReceiptsStatus />
      </section>

      <section className="card glass">
        <h3 className="sec">Test mode</h3>
        <Switch checked={form.testMode} onChange={(v) => set("testMode", v)}>
          Test mode
        </Switch>
        <div className="hint">
          While it is on, every new item is a sandbox item and the inbox shows sandbox items instead of real ones.
        </div>
      </section>

      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending && <span className="spinner" aria-hidden="true" />}
          Save settings
        </button>
        <span className="hint">Version {initial.version}</span>
      </div>
    </form>
  );
}

/** Settings the host holds, shown as they are: nothing here to change. */
function HeldList({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <>
      <dl className="fields held">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || "—"}</dd>
            </div>
          ))}
      </dl>
      <p className="hint">Set by your host.</p>
    </>
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
          Issuing receipts as <span className="mono">{r.issuer}</span>. A booking gets one when it is confirmed, an
          order when it is accepted or paid, and each another for how it ended; the customer's assistant can
          counter-sign them.
        </div>
      ) : (
        <div className="hint">Not issuing receipts. {r.reason}</div>
      )}
      <div className="rowx">
        <span className="pill pill-xs">{r.issued} issued</span>
        <span className="pill pill-xs">{r.acknowledged} counter-signed</span>
        <span className="pill pill-xs">
          {r.keys} signing key{r.keys === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
