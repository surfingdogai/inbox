import clsx from "clsx";
import { CalendarDays, ChevronRight, CreditCard, ExternalLink, RefreshCw, ShoppingBag } from "lucide-react";
import { useEffect, useState } from "react";
import { type ApiProblem, api, problemOf } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useIntegrations, useIntegrationWrite, useServices } from "../lib/queries";
import type { ConnectionView, FormField, GalleryCard, GalleryWay } from "../lib/types";
import { ErrorState, Toast } from "./Feedback";
import { Field, SectionHead, Switch } from "./Form";

/**
 * Settings → Integrations, the gallery (ADR-020): one card per thing an owner recognises, its ways
 * in, and what is connected. The form for each way is drawn from the connector's own schema, so a
 * connector added later needs no screen of its own. A card that is not built yet says "Soon" and
 * has nothing to press.
 */

interface Notice {
  readonly tone: "success" | "danger";
  readonly text: string;
}

const ICONS = { calendars: CalendarDays, payments: CreditCard, shops: ShoppingBag } as const;

export function IntegrationsCard() {
  const integrations = useIntegrations();
  const write = useIntegrationWrite();
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const data = integrations.data;

  // Back from signing in on a platform: what happened is in the address, said once, then cleared.
  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("connected");
    const failed = url.searchParams.get("connect_error");
    if (!connected && !failed) return;
    setNotice(
      failed ? { tone: "danger", text: failed } : { tone: "success", text: "Connected. Reading your calendar now." },
    );
    url.searchParams.delete("connected");
    url.searchParams.delete("connect_error");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  const connectedCards = new Set(
    (data?.connections ?? []).map((c) =>
      c.kind === "calcom" ? "calcom" : c.kind === "caldav" || c.kind === "google_calendar" ? "calendar" : c.kind,
    ),
  );
  const card = data?.cards.find((c) => c.id === open) ?? null;

  return (
    <section className="card glass stack">
      <SectionHead title="Connect" />
      <p className="lede small">Busy times come in. Confirmed bookings go out.</p>
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      {integrations.isPending && <div className="skeleton sk-line" />}
      {integrations.isError && (
        <ErrorState
          title="Could not load the integrations"
          text={problemOf(integrations.error).detail}
          onRetry={() => void integrations.refetch()}
        />
      )}
      {data && !data.can_connect && (
        <p className="hint" role="note">
          Connecting needs INBOX_SECRET_KEY on the server, so passwords can be stored locked.
        </p>
      )}
      {data && (
        <div className="int-grid">
          {data.cards.map((c) => (
            <Tile
              key={c.id}
              card={c}
              connected={connectedCards.has(c.id)}
              open={open === c.id}
              disabled={!data.can_connect}
              onOpen={() => {
                write.reset();
                setNotice(null);
                setOpen(open === c.id ? null : c.id);
              }}
            />
          ))}
        </div>
      )}
      {card && card.status === "ready" && data?.can_connect && (
        <ConnectPanel
          key={card.id}
          card={card}
          pending={write.isPending}
          error={write.error ? problemOf(write.error) : null}
          onCancel={() => setOpen(null)}
          onConnect={(body) =>
            write.mutate(
              { connect: body },
              {
                onSuccess: () => {
                  setOpen(null);
                  setNotice({ tone: "success", text: "Connected. Reading your calendar now." });
                },
              },
            )
          }
          onError={(text) => setNotice({ tone: "danger", text })}
        />
      )}
      {(data?.connections.length ?? 0) > 0 && (
        <div className="stack int-connections">
          {data?.connections.map((c) => (
            <ConnectionLine key={c.id} connection={c} onNotice={setNotice} />
          ))}
        </div>
      )}
    </section>
  );
}

function Tile({
  card,
  connected,
  open,
  disabled,
  onOpen,
}: {
  card: GalleryCard;
  connected: boolean;
  open: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const Icon = ICONS[card.group];
  const soon = card.status === "soon";
  const body = (
    <>
      <Icon className="icon int-icon" aria-hidden="true" />
      <span className="int-text">
        <span className="int-name">{card.title}</span>
        <span className="int-line">{card.line}</span>
      </span>
      {soon ? (
        <span className="int-tag">Soon</span>
      ) : connected ? (
        <span className="int-tag is-on">Connected</span>
      ) : null}
    </>
  );
  if (soon) {
    return <div className="int-tile is-soon">{body}</div>;
  }
  return (
    <button
      type="button"
      className={clsx("int-tile", open && "is-open")}
      aria-expanded={open}
      disabled={disabled}
      onClick={onOpen}
    >
      {body}
    </button>
  );
}

function ConnectPanel({
  card,
  pending,
  error,
  onConnect,
  onCancel,
  onError,
}: {
  card: GalleryCard;
  pending: boolean;
  error: ApiProblem | null;
  onConnect: (body: { kind: string; preset?: string; values: Record<string, string> }) => void;
  onCancel: () => void;
  onError: (text: string) => void;
}) {
  const ready = card.ways.filter((w) => w.status === "ready");
  const [wayKey, setWayKey] = useState(() => keyOf(ready[0] ?? card.ways[0]));
  const way = card.ways.find((w) => keyOf(w) === wayKey) ?? ready[0];
  if (!way) return null;
  return (
    <div className="confirm row-glass stack int-panel">
      {card.ways.length > 1 && (
        <fieldset className="seg">
          <legend className="sr-only">Which {card.title.toLowerCase()}</legend>
          {card.ways.map((w) => (
            <button
              key={keyOf(w)}
              type="button"
              aria-pressed={keyOf(w) === wayKey}
              disabled={w.status !== "ready"}
              title={w.status === "ready" ? undefined : "Soon"}
              onClick={() => setWayKey(keyOf(w))}
            >
              {w.label}
              {w.status !== "ready" && <span className="opt"> · soon</span>}
            </button>
          ))}
        </fieldset>
      )}
      {way.auth === "oauth" ? (
        <SignIn way={way} onCancel={onCancel} onError={onError} />
      ) : (
        <WayForm
          key={keyOf(way)}
          way={way}
          pending={pending}
          error={error}
          onCancel={onCancel}
          onSubmit={(values) => onConnect({ kind: way.kind, ...(way.preset ? { preset: way.preset } : {}), values })}
        />
      )}
    </div>
  );
}

function keyOf(w: GalleryWay | undefined): string {
  return w ? `${w.kind}:${w.preset ?? ""}` : "";
}

function SignIn({ way, onCancel, onError }: { way: GalleryWay; onCancel: () => void; onError: (t: string) => void }) {
  const [going, setGoing] = useState(false);
  return (
    <div className="stack">
      <p className="hint">
        You will be asked to let this inbox see when you are busy and add the bookings it confirms.
      </p>
      <div className="rowx">
        <button
          type="button"
          className="btn btn-primary"
          disabled={going}
          onClick={async () => {
            setGoing(true);
            try {
              const { authorize_url } = await api.authorizeIntegration(way.kind);
              window.location.assign(authorize_url);
            } catch (e) {
              setGoing(false);
              onError(problemOf(e).detail);
            }
          }}
        >
          {going ? "Opening…" : `Continue with ${way.label}`}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function WayForm({
  way,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  way: GalleryWay;
  pending: boolean;
  error: ApiProblem | null;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const main = way.form.filter((f) => !f.advanced);
  const advanced = way.form.filter((f) => f.advanced);
  const missing = main.some((f) => f.required && !(values[f.key] ?? "").trim());
  const fieldError = (f: FormField) => error?.field(`values.${f.key}`);
  const shown = new Set(way.form.map((f) => `values.${f.key}`));
  const general = error && !(error.fields ?? []).some((f) => shown.has(f.path));
  const input = (f: FormField) => (
    <div key={f.key} className="int-field">
      <Field id={`int-${f.key}`} label={f.label} hint={f.help} error={fieldError(f)} optional={!f.required}>
        <input
          id={`int-${f.key}`}
          className="input"
          type={f.input === "url" ? "text" : f.input}
          inputMode={f.input === "url" ? "url" : f.input === "email" ? "email" : undefined}
          autoComplete={f.secret ? "new-password" : (f.autocomplete ?? "off")}
          spellCheck={false}
          placeholder={f.placeholder}
          value={values[f.key] ?? ""}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          required={f.required}
        />
      </Field>
      {f.link && (
        <a className="int-link" href={f.link.href} target="_blank" rel="noopener noreferrer">
          {f.link.text}
          <ExternalLink className="icon-xs" aria-hidden="true" />
        </a>
      )}
    </div>
  );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
      }}
    >
      {way.note && <p className="hint">{way.note}</p>}
      {main.map(input)}
      {advanced.length > 0 && (
        <details className="advanced">
          <summary className="disclosure">
            <ChevronRight className="icon-sm disclosure-icon" aria-hidden="true" />
            <span className="disclosure-open">Fewer options</span>
            <span className="disclosure-closed">More options</span>
          </summary>
          <div className="advanced-body stack">{advanced.map(input)}</div>
        </details>
      )}
      {general && (
        <p className="hint error" role="alert">
          {error.detail}
        </p>
      )}
      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={pending || missing}>
          {pending ? "Checking…" : "Connect"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const STATUS: Record<string, string> = {
  configured: "Reading…",
  active: "Connected",
  error: "Failing",
  disabled: "Paused",
};

function ConnectionLine({ connection: c, onNotice }: { connection: ConnectionView; onNotice: (n: Notice) => void }) {
  const write = useIntegrationWrite();
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const destination = c.destinations.find((d) => d.id === c.destination);
  const meta = [
    c.busy_on
      ? c.status === "configured"
        ? "reading busy times"
        : `${c.busy_times} busy ${c.busy_times === 1 ? "time" : "times"} ahead`
      : "busy times off",
    c.bookings_on
      ? destination && c.kind !== "calcom"
        ? `bookings go to ${destination.name}`
        : "bookings go out"
      : "bookings off",
    c.last_sync_at ? `synced ${relativeTime(new Date(c.last_sync_at).toISOString())}` : null,
  ].filter(Boolean);
  const problem = write.error ? problemOf(write.error) : null;
  return (
    <div className={clsx("int-conn row-glass", c.status === "disabled" && "is-paused")}>
      <div className="int-conn-main">
        <div className="int-conn-head">
          <span className="int-title">{c.title}</span>
          <span className="int-account">{c.account}</span>
          <span className={clsx("pill pill-xs", c.status === "error" && "is-warn")}>
            {STATUS[c.status] ?? c.status}
          </span>
        </div>
        <div className="int-meta">{meta.join(" · ")}</div>
        {c.status === "error" && c.last_error && (
          <div className="hint error" role="alert">
            {c.last_error}
          </div>
        )}
        {c.bookings_failing > 0 && c.booking_error && (
          <div className="hint error" role="alert">
            {c.bookings_failing === 1 ? "A booking was not added" : `${c.bookings_failing} bookings were not added`}:{" "}
            {c.booking_error}
          </div>
        )}
        {problem && (
          <div className="hint error" role="alert">
            {problem.detail}
          </div>
        )}
      </div>
      <div className="rowx int-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={`Sync ${c.title} now`}
          disabled={write.isPending || c.status === "disabled"}
          onClick={() =>
            write.mutate(
              { id: c.id, sync: true },
              { onSuccess: () => onNotice({ tone: "success", text: "Syncing now." }) },
            )
          }
        >
          <RefreshCw className="icon-sm" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-expanded={choosing}
          onClick={() => setChoosing(!choosing)}
        >
          Choose
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
          Disconnect
        </button>
      </div>
      {choosing && <Choices connection={c} onDone={() => setChoosing(false)} onNotice={onNotice} />}
      {confirming && (
        <div className="confirm row-glass wide">
          <h3>Disconnect {c.title}</h3>
          <p className="hint">Its busy times stop blocking at once. Bookings already added stay in the calendar.</p>
          <div className="rowx">
            <button
              type="button"
              className="btn btn-danger"
              disabled={write.isPending}
              onClick={() =>
                write.mutate(
                  { id: c.id, remove: true },
                  { onSuccess: () => onNotice({ tone: "success", text: `${c.title} is disconnected.` }) },
                )
              }
            >
              Disconnect
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Choices({
  connection: c,
  onDone,
  onNotice,
}: {
  connection: ConnectionView;
  onDone: () => void;
  onNotice: (n: Notice) => void;
}) {
  const write = useIntegrationWrite();
  const services = useServices();
  const [busy, setBusy] = useState<string[]>([...c.busy_calendars]);
  const [destination, setDestination] = useState<string | null>(c.destination);
  const [only, setOnly] = useState<string[] | null>(c.services ? [...c.services] : null);
  const [busyOn, setBusyOn] = useState(c.busy_on);
  const [bookingsOn, setBookingsOn] = useState(c.bookings_on);
  const active = (services.data?.items ?? []).filter((s) => s.active === 1);
  const writable = c.destinations.filter((d) => d.writable);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <div className="confirm row-glass wide stack">
      <Switch checked={busyOn} onChange={setBusyOn}>
        Block times this calendar is busy
      </Switch>
      {busyOn && c.calendars.length > 1 && (
        <fieldset className="chips-field">
          <legend className="label">From</legend>
          <div className="chips">
            {c.calendars.map((cal) => (
              <button
                key={cal.id}
                type="button"
                className="chip chip-toggle"
                aria-pressed={busy.includes(cal.id)}
                onClick={() => setBusy(toggle(busy, cal.id))}
              >
                {cal.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {busyOn && active.length > 1 && (
        <fieldset className="chips-field">
          <legend className="label">For</legend>
          <div className="chips">
            <button
              type="button"
              className="chip chip-toggle"
              aria-pressed={only === null}
              onClick={() => setOnly(null)}
            >
              Every service
            </button>
            {active.map((s) => (
              <button
                key={s.id}
                type="button"
                className="chip chip-toggle"
                aria-pressed={only?.includes(s.id) ?? false}
                onClick={() => {
                  const next = toggle(only ?? [], s.id);
                  setOnly(next.length === 0 ? null : next);
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {c.capabilities.includes("write_bookings") && (
        <Switch checked={bookingsOn} onChange={setBookingsOn}>
          Add confirmed bookings
        </Switch>
      )}
      {bookingsOn && writable.length > 1 && (
        <Field id={`dest-${c.id}`} label={c.kind === "calcom" ? "As" : "To"}>
          <select
            id={`dest-${c.id}`}
            className="input"
            value={destination ?? ""}
            onChange={(e) => setDestination(e.target.value || null)}
          >
            {writable.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="rowx">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={write.isPending}
          onClick={() =>
            write.mutate(
              {
                id: c.id,
                patch: {
                  busy_on: busyOn,
                  bookings_on: bookingsOn,
                  ...(c.calendars.length > 0 ? { busy_calendars: busy } : {}),
                  ...(writable.length > 0 ? { destination } : {}),
                  services: only,
                },
              },
              {
                onSuccess: () => {
                  onDone();
                  onNotice({ tone: "success", text: "Saved. Reading your calendar again." });
                },
              },
            )
          }
        >
          Save
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={write.isPending}
          onClick={() =>
            write.mutate(
              { id: c.id, patch: { paused: c.status !== "disabled" } },
              {
                onSuccess: () => onNotice({ tone: "success", text: c.status === "disabled" ? "Resumed." : "Paused." }),
              },
            )
          }
        >
          {c.status === "disabled" ? "Resume" : "Pause"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Close
        </button>
      </div>
      {write.error && (
        <p className="hint error" role="alert">
          {problemOf(write.error).detail}
        </p>
      )}
    </div>
  );
}
