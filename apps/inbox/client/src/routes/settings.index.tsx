import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, Switch } from "../components/Form";
import { problemOf } from "../lib/api";
import { qk, useProfile, useReceiptStatus, useSaveProfile, useSaveSettings, useSettings } from "../lib/queries";
import { type SettingsForm as SettingsFormState, toSettingsDoc, toSettingsForm } from "../lib/settings";
import type { Profile, SettingsDoc } from "../lib/types";

export const Route = createFileRoute("/settings/")({
  component: GeneralPage,
});

const TIME_ZONES: readonly string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

/** The business (its own row) and the settings document (versioned): two forms, each saved on its own. */
function GeneralPage() {
  const profile = useProfile();
  const settings = useSettings();
  const qc = useQueryClient();
  const [saved, setSaved] = useState<string | null>(null);
  const reload = () => {
    setSaved(null);
    void qc.invalidateQueries({ queryKey: qk.settings });
  };
  return (
    <>
      {saved && <Toast tone="success" text={saved} onDismiss={() => setSaved(null)} />}
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
      {profile.data && (
        <ProfileForm
          key={JSON.stringify(profile.data)}
          initial={profile.data}
          onSaved={() => setSaved("Business profile saved.")}
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
          key={settings.data.version}
          initial={settings.data}
          onSaved={() => setSaved("Settings saved.")}
          onReload={reload}
        />
      )}
    </>
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

// ---- the business row ---------------------------------------------------------------------

interface ProfileDraft {
  readonly name: string;
  readonly domain: string;
  readonly timezone: string;
  readonly currency: string;
  readonly languages: string;
}

function ProfileForm({ initial, onSaved }: { initial: Profile; onSaved: () => void }) {
  const [form, setForm] = useState<ProfileDraft>({
    name: initial.name,
    domain: initial.domain ?? "",
    timezone: initial.timezone,
    currency: initial.currency,
    languages: initial.languages.join(", "),
  });
  const save = useSaveProfile();
  const problem = save.error ? problemOf(save.error) : null;
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const languages = form.languages
      .split(/[,\s]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    save.mutate(
      {
        name: form.name.trim(),
        domain: form.domain.trim() ? form.domain.trim().toLowerCase() : null,
        timezone: form.timezone.trim(),
        currency: form.currency.trim().toUpperCase(),
        ...(languages.length ? { languages } : {}),
      },
      { onSuccess: onSaved },
    );
  };
  return (
    <form className="card glass stack" onSubmit={submit}>
      <h3 className="sec">Business</h3>
      {problem && !problem.fields?.length && (
        <Toast tone="danger" text="The profile was not saved." sub={problem.detail} />
      )}
      <div className="settings-grid">
        <Field id="p-name" label="Name" error={problem?.field("name")}>
          <input id="p-name" className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field
          id="p-domain"
          label="Domain"
          optional
          error={problem?.field("domain")}
          hint="Where agents find you, like shop.example.com. Also how a network verifies you."
        >
          <input
            id="p-domain"
            className="input"
            inputMode="url"
            spellCheck={false}
            value={form.domain}
            onChange={(e) => set("domain", e.target.value)}
          />
        </Field>
        <Field id="p-tz" label="Time zone" error={problem?.field("timezone")} hint="Bookings and opening hours use it.">
          <input
            id="p-tz"
            className="input"
            list="p-tz-list"
            value={form.timezone}
            onChange={(e) => set("timezone", e.target.value)}
          />
          <datalist id="p-tz-list">
            {TIME_ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
        <Field id="p-currency" label="Currency" error={problem?.field("currency")} hint="Three letters, like EUR.">
          <input
            id="p-currency"
            className="input"
            maxLength={3}
            autoCapitalize="characters"
            value={form.currency}
            onChange={(e) => set("currency", e.target.value)}
          />
        </Field>
        <Field id="p-langs" label="Languages" error={problem?.field("languages")} hint="Comma-separated, like pt, en.">
          <input
            id="p-langs"
            className="input"
            value={form.languages}
            onChange={(e) => set("languages", e.target.value)}
          />
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
  onSaved,
  onReload,
}: {
  initial: SettingsDoc;
  onSaved: () => void;
  onReload: () => void;
}) {
  const [form, setForm] = useState<SettingsFormState>(() => toSettingsForm(initial.doc, initial.redacted ?? []));
  const save = useSaveSettings();
  const problem = save.error ? problemOf(save.error) : null;
  const conflict = problem?.code === "version_conflict";
  const set = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const field = (path: string) => problem?.field(path);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    save.mutate({ doc: toSettingsDoc(form), expected_version: initial.version }, { onSuccess: onSaved });
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
          <div className="wide">
            <Switch checked={form.holdOnPropose} onChange={(v) => set("holdOnPropose", v)}>
              Hold the slot while a proposed time is pending
            </Switch>
          </div>
        </div>
      </section>

      <section className="card glass">
        <h3 className="sec">Notifications and email</h3>
        <div className="settings-grid">
          <Field
            id="s-owner-email"
            label="Tell me at"
            optional
            error={field("notifications.ownerEmail")}
            hint="Where new items and replies are announced. Empty means no owner emails."
          >
            <input
              id="s-owner-email"
              className="input"
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
            hint="Used in email links, like https://inbox.example.com. Networks also know your inbox by it."
          >
            <input
              id="s-app-url"
              className="input"
              type="url"
              value={form.appUrl}
              onChange={(e) => set("appUrl", e.target.value)}
            />
          </Field>
          <Field id="s-from" label="Send from" optional error={field("email.fromAddress")}>
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
            hint={
              form.inboundSecretSet
                ? "A secret is set. It is never shown again; type a new one to replace it, or leave this empty to keep it."
                : "At least 16 characters; sent by your mail provider's webhook in X-Inbox-Email-Secret."
            }
          >
            <input
              id="s-inbound"
              className="input"
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
          order when it is paid; the customer's agent can counter-sign it.
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
