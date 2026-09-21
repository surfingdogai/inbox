import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { problemOf } from "../lib/api";
import { isSignedIn } from "../lib/auth";
import { qk, useSaveSettings, useSettings } from "../lib/queries";
import type { Settings, SettingsDoc } from "../lib/types";

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (!isSignedIn()) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: SettingsPage,
});

function SettingsPage() {
  const settings = useSettings();
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  const reload = () => {
    setSaved(false);
    void qc.invalidateQueries({ queryKey: qk.settings });
  };
  return (
    <main className="page page-narrow">
      <div className="page-head">
        <Link to="/" className="btn btn-ghost btn-sm">
          <ArrowLeft className="icon" aria-hidden="true" />
          Inbox
        </Link>
        <h1>Settings</h1>
        <ThemeSwitch />
      </div>
      {saved && <Toast tone="success" text="Settings saved." onDismiss={() => setSaved(false)} />}
      {settings.isPending && (
        <div className="card glass" aria-busy="true">
          <div className="skeleton sk-title" />
          <div className="skeleton sk-line" />
        </div>
      )}
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
          key={settings.data.version}
          initial={settings.data}
          onSaved={() => setSaved(true)}
          onReload={reload}
        />
      )}
    </main>
  );
}

interface Form {
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly languages: string;
  readonly cancellationWindowMin: string;
  readonly holdOnPropose: boolean;
  readonly autoExpireHours: string;
  readonly testMode: boolean;
}

function toForm(doc: Settings): Form {
  return {
    name: doc.business.name,
    timezone: doc.business.timezone,
    currency: doc.business.currency,
    languages: doc.business.languages.join(", "),
    cancellationWindowMin: String(doc.booking.cancellationWindowMin),
    holdOnPropose: doc.booking.holdOnPropose,
    autoExpireHours: String(doc.booking.autoExpireHours),
    testMode: doc.testMode,
  };
}

/** The whole document goes back: fields this screen does not know stay as they were. */
function toDoc(base: Settings, f: Form): Record<string, unknown> {
  const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));
  return {
    ...base,
    business: {
      ...base.business,
      name: f.name.trim(),
      timezone: f.timezone.trim(),
      currency: f.currency.trim().toUpperCase(),
      languages: f.languages
        .split(/[,\s]+/)
        .map((l) => l.trim())
        .filter(Boolean),
    },
    booking: {
      ...base.booking,
      cancellationWindowMin: num(f.cancellationWindowMin),
      holdOnPropose: f.holdOnPropose,
      autoExpireHours: num(f.autoExpireHours),
    },
    testMode: f.testMode,
  };
}

const TIME_ZONES: readonly string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

function SettingsForm({
  initial,
  onSaved,
  onReload,
}: {
  initial: SettingsDoc;
  onSaved: () => void;
  onReload: () => void;
}) {
  const [form, setForm] = useState<Form>(() => toForm(initial.doc));
  const save = useSaveSettings();
  const problem = save.error ? problemOf(save.error) : null;
  const conflict = problem?.code === "version_conflict";
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const field = (path: string) => problem?.field(path);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    save.mutate({ doc: toDoc(initial.doc, form), expected_version: initial.version }, { onSuccess: onSaved });
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
        <h3 className="sec">Business</h3>
        <div className="settings-grid">
          <Field id="s-name" label="Name" error={field("business.name")}>
            <input id="s-name" className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field
            id="s-tz"
            label="Time zone"
            error={field("business.timezone")}
            hint="Bookings and opening hours use it."
          >
            <input
              id="s-tz"
              className="input"
              list="s-tz-list"
              value={form.timezone}
              onChange={(e) => set("timezone", e.target.value)}
            />
            <datalist id="s-tz-list">
              {TIME_ZONES.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>
          <Field id="s-currency" label="Currency" error={field("business.currency")} hint="Three letters, like EUR.">
            <input
              id="s-currency"
              className="input"
              maxLength={3}
              autoCapitalize="characters"
              value={form.currency}
              onChange={(e) => set("currency", e.target.value)}
            />
          </Field>
          <Field
            id="s-langs"
            label="Languages"
            error={field("business.languages")}
            hint="Comma-separated, like en, pt."
          >
            <input
              id="s-langs"
              className="input"
              value={form.languages}
              onChange={(e) => set("languages", e.target.value)}
            />
          </Field>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Bookings</h3>
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
          <label className="check wide">
            <span className="switch">
              <input
                type="checkbox"
                checked={form.holdOnPropose}
                onChange={(e) => set("holdOnPropose", e.target.checked)}
              />
              <span />
            </span>
            Hold the slot while a proposed time is pending
          </label>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Test mode</h3>
        <label className="check">
          <span className="switch">
            <input type="checkbox" checked={form.testMode} onChange={(e) => set("testMode", e.target.checked)} />
            <span />
          </span>
          Test mode
        </label>
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

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <div className="hint error" role="alert">
          {error}
        </div>
      ) : (
        hint && <div className="hint">{hint}</div>
      )}
    </div>
  );
}
