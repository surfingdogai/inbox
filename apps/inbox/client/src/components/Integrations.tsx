import clsx from "clsx";
import {
  BedDouble,
  CalendarCheck,
  CalendarDays,
  Check,
  ChevronRight,
  Copy,
  CreditCard,
  ExternalLink,
  RefreshCw,
  ShoppingBag,
  Store,
  Wrench,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { type ApiProblem, api, problemOf } from "../lib/api";
import { session } from "../lib/auth";
import { cardState } from "../lib/connect";
import { useIntegrations, useIntegrationWrite, useServices } from "../lib/queries";
import type { ConnectionView, FormField, GalleryCard, GalleryWay } from "../lib/types";
import { ErrorState, Toast } from "./Feedback";
import { Field, SectionHead, Switch } from "./Form";

/**
 * Settings → Integrations, the gallery (ADR-022, ADR-026): what is connected first, then the cards in
 * their groups (Calendars, Payments, Shops and tills), each one thing an owner recognises, with its
 * ways in. Everything here is drawn from what the server says: the form from the connector's own
 * schema, a sign-in's words and what it asks first, a link to make, the choosers once connected, so a
 * connector added later needs no screen of its own and no change to this file. A card being built says
 * "Soon" and has nothing to press; on a phone those are one quiet line.
 */

interface Notice {
  readonly tone: "success" | "danger";
  readonly text: string;
}

const ICONS = {
  calendars: CalendarDays,
  payments: CreditCard,
  shops: ShoppingBag,
  lodging: BedDouble,
  work: Wrench,
  pos: Store,
  booking: CalendarCheck,
} as const;

/** The card a connection belongs to, as the server says. */
const cardOf = (c: ConnectionView) => c.card ?? c.kind;

/** The address the owner signs in with: a way in is picked from it, and its email field filled. */
function useOwnerEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void session().then((u) => {
      if (live) setEmail(u?.email ?? null);
    });
    return () => {
      live = false;
    };
  }, []);
  return email;
}

export function IntegrationsCard({ skip = [] }: { skip?: readonly string[] } = {}) {
  const integrations = useIntegrations();
  const write = useIntegrationWrite();
  const email = useOwnerEmail();
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

  const connections = data?.connections ?? [];
  const byCard = new Map<string, ConnectionView[]>();
  for (const c of connections) byCard.set(cardOf(c), [...(byCard.get(cardOf(c)) ?? []), c]);
  const card = data?.cards.find((c) => c.id === open) ?? null;
  // Still to come here (not the ones that need this server's operator first, which say so on their tile).
  const soon = (data?.cards ?? []).filter((c) => cardState(c).tag === "Soon");
  // Payments (ADR-023): one platform sends an order's links per mode; the one that does is named. A shop
  // that takes its orders at its own checkout is one of them (ADR-026).
  const sending = connections.filter((c) => c.payments && c.pay_on && !c.payments.disconnecting);
  const insteadOf = (cardId: string): string | null => {
    const other = sending.find((c) => cardOf(c) !== cardId);
    return other ? other.title : null;
  };
  const pays = (c: GalleryCard) => c.group === "payments" || c.group === "shops";
  const groups = data?.groups?.length
    ? data.groups
    : [
        { id: "calendars" as const, label: "Calendars" },
        { id: "payments" as const, label: "Payments" },
        { id: "shops" as const, label: "Shops and tills" },
      ];
  // Cal.com adds the bookings it is given to the calendar it checks, so with both adding them each
  // booking would show twice there.
  const calcom = connections.find((c) => c.kind === "calcom" && c.bookings_on && c.status !== "disabled");
  const twice = connections.find(
    (c) => (c.kind === "caldav" || c.kind === "google_calendar") && c.bookings_on && c.status !== "disabled",
  );

  return (
    <section className="card glass stack">
      <SectionHead title="Connect" />
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
          Connecting needs INBOX_SECRET_KEY on the server, so passwords are stored encrypted.
        </p>
      )}
      {connections.length > 0 && (
        <div className="stack int-connections">
          {connections.map((c) => (
            <ConnectionLine
              key={c.id}
              connection={c}
              connections={connections}
              cards={data?.cards ?? []}
              onNotice={setNotice}
            />
          ))}
        </div>
      )}
      {calcom && twice && (
        <p className="hint int-twice" role="note">
          Cal.com adds its bookings to your calendar too, so each would show twice.{" "}
          <button
            type="button"
            className="int-inline"
            disabled={write.isPending}
            onClick={() =>
              write.mutate(
                { id: twice.id, patch: { bookings_on: false } },
                { onSuccess: () => setNotice({ tone: "success", text: `${twice.title} no longer adds bookings.` }) },
              )
            }
          >
            Stop adding them from {twice.title}
          </button>
        </p>
      )}
      {data && (
        <div className="int-groups">
          {groups.map((g) => {
            // A kind of business leaves out the cards it has no use for (a place to stay books no minutes).
            const cards = data.cards.filter((c) => c.group === g.id && !skip.includes(c.id));
            if (cards.length === 0) return null;
            // A group whose cards are all still to come: on a phone, its heading goes with its tiles.
            const allSoon = cards.every((c) => cardState(c).tag === "Soon" && (byCard.get(c.id) ?? []).length === 0);
            const here = card && card.group === g.id ? card : null;
            const keyPanel = here && here.group === "payments" && (byCard.get(here.id) ?? []).length > 0;
            return (
              <div key={g.id} className={clsx("int-group stack-xs", allSoon && "is-all-soon")}>
                <h3 className="int-group-head">{g.label}</h3>
                <div className="int-grid">
                  {cards.map((c) => (
                    <Tile
                      key={c.id}
                      card={c}
                      connections={byCard.get(c.id) ?? []}
                      instead={pays(c) && !(byCard.get(c.id) ?? []).length ? insteadOf(c.id) : null}
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
                {here && keyPanel && data.can_connect && (
                  <PayKeyPanel
                    key={here.id}
                    card={here}
                    connections={byCard.get(here.id) ?? []}
                    onCancel={() => setOpen(null)}
                    onNotice={(n) => {
                      if (n.tone === "success") setOpen(null);
                      setNotice(n);
                    }}
                  />
                )}
                {here && here.status === "ready" && !keyPanel && data.can_connect && (
                  <ConnectPanel
                    key={here.id}
                    card={here}
                    email={email}
                    instead={pays(here) ? insteadOf(here.id) : null}
                    pending={write.isPending}
                    error={write.error ? problemOf(write.error) : null}
                    onCancel={() => setOpen(null)}
                    onConnect={(body, way) =>
                      write.mutate(
                        { connect: body },
                        {
                          onSuccess: () => {
                            setOpen(null);
                            setNotice({ tone: "success", text: connectedText(here, way) });
                          },
                        },
                      )
                    }
                    onError={(text) => setNotice({ tone: "danger", text })}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {soon.length > 0 && (
        <div className="int-soon-block">
          <p className="int-soon-line">Coming: {soon.map((c) => c.title).join(" · ")}</p>
        </div>
      )}
    </section>
  );
}

/** What the owner is told once a way connected, in the words of what it does. */
function connectedText(card: GalleryCard, way: GalleryWay): string {
  if (way.auth === "link") return "Your link is made. Copy it from its line above.";
  if (card.group === "shops") return `${card.title} is connected. Reading your catalogue now.`;
  if (card.group === "payments") return `${card.title} is connected. Orders you accept get a link to pay.`;
  return "Connected. Reading your calendar now.";
}

/** What a card's tag says: the worst of its connections. */
function tagOf(connections: readonly ConnectionView[]): { text: string; tone: "on" | "warn" | "quiet" } | null {
  if (connections.length === 0) return null;
  if (connections.every((c) => c.payments?.disconnecting)) return { text: "Disconnecting", tone: "quiet" };
  if (connections.some((c) => c.status === "error")) return { text: "Failing", tone: "warn" };
  if (connections.every((c) => c.status === "disabled")) return { text: "Paused", tone: "quiet" };
  return { text: "Connected", tone: "on" };
}

function Tile({
  card,
  connections,
  instead,
  open,
  disabled,
  onOpen,
}: {
  card: GalleryCard;
  connections: readonly ConnectionView[];
  /** A payment platform not connected while another sends the links: "Instead of Mollie". */
  instead?: string | null;
  open: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const Icon = ICONS[card.group];
  // The same word as on the Property page: Soon, or Needs setup with what this server's operator sets.
  const state = cardState(card);
  const soon = state.tag !== null;
  const tag = tagOf(connections);
  const body = (
    <>
      <Icon className="icon int-icon" aria-hidden="true" />
      <span className="int-text">
        <span className="int-name">{card.title}</span>
        <span className="int-line">
          {instead && card.status === "ready" ? `Instead of ${instead}` : (state.hint ?? card.line)}
        </span>
      </span>
      {soon ? (
        <span className="int-tag">{state.tag}</span>
      ) : tag ? (
        <span className={clsx("int-tag", tag.tone === "on" && "is-on", tag.tone === "warn" && "is-warn")}>
          {tag.text}
        </span>
      ) : null}
    </>
  );
  if (soon) {
    return <div className={clsx("int-tile", state.tag === "Soon" ? "is-soon" : "is-setup")}>{body}</div>;
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

const APPLE = new Set(["icloud.com", "me.com", "mac.com"]);
const FASTMAIL = new Set(["fastmail.com", "fastmail.fm"]);
const GOOGLE = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT = /^(outlook|hotmail|live|msn)\.[a-z.]+$/;

/**
 * The way in to open first, from the owner's own address: iCloud for an iCloud address, Google for
 * Gmail, and so on. A Google or Outlook owner whose way is not ready here yet is offered the
 * calendar's private link, and told why.
 */
function preferredWay(card: GalleryCard, email: string | null): { way: GalleryWay | undefined; hint?: string } {
  const ready = card.ways.filter((w) => w.status === "ready");
  const find = (kind: string, preset: string | null = null) =>
    card.ways.find((w) => w.kind === kind && w.preset === preset);
  const link = find("ics");
  const domain = email?.slice(email.lastIndexOf("@") + 1).toLowerCase() ?? "";
  if (APPLE.has(domain) && find("caldav", "icloud")?.status === "ready") return { way: find("caldav", "icloud") };
  if (FASTMAIL.has(domain) && find("caldav", "fastmail")?.status === "ready")
    return { way: find("caldav", "fastmail") };
  if (GOOGLE.has(domain)) {
    const google = find("google_calendar");
    if (google?.status === "ready") return { way: google };
    if (link?.status === "ready") {
      return {
        way: link,
        hint:
          google?.status === "setup"
            ? "Google needs setting up on this server first. Until then, your Google calendar's private link blocks your busy times."
            : "Google connects here soon. Until then, your Google calendar's private link blocks your busy times.",
      };
    }
  }
  const outlook = find("ics", "outlook");
  if (MICROSOFT.test(domain) && outlook?.status === "ready") return { way: outlook };
  return { way: ready.find((w) => !w.advanced) ?? ready[0] };
}

function ConnectPanel({
  card,
  email,
  instead,
  pending,
  error,
  onConnect,
  onCancel,
  onError,
}: {
  card: GalleryCard;
  email: string | null;
  /** Another payment platform sends the links now: connecting this one asks to send them from it instead. */
  instead?: string | null;
  pending: boolean;
  error: ApiProblem | null;
  onConnect: (body: { kind: string; preset?: string; values: Record<string, string> }, way: GalleryWay) => void;
  onCancel: () => void;
  onError: (text: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const preferred = preferredWay(card, email);
  const way = card.ways.find((w) => keyOf(w) === (picked ?? keyOf(preferred.way))) ?? preferred.way;
  const setup = card.ways.filter((w) => w.status === "setup");
  const main = card.ways.filter((w) => !w.advanced);
  const others = card.ways.filter((w) => w.advanced && w.status === "ready" && keyOf(w) !== keyOf(way));
  const body = (w: GalleryWay, values: Record<string, string>) => ({
    kind: w.kind,
    ...(w.preset ? { preset: w.preset } : {}),
    values,
  });
  if (!way) return null;
  return (
    <div className="confirm row-glass stack int-panel">
      {main.length > 1 && !way.advanced && (
        <fieldset className="seg">
          <legend className="sr-only">Which {card.title.toLowerCase()}</legend>
          {main.map((w) => (
            <button
              key={keyOf(w)}
              type="button"
              aria-pressed={keyOf(w) === keyOf(way)}
              disabled={w.status !== "ready"}
              title={w.status === "ready" ? undefined : (w.hint ?? "Soon")}
              onClick={() => setPicked(keyOf(w))}
            >
              {w.label}
              {w.status === "soon" && <span className="opt"> · soon</span>}
              {w.status === "setup" && <span className="opt"> · set up</span>}
            </button>
          ))}
        </fieldset>
      )}
      {picked === null && preferred.hint && <p className="hint">{preferred.hint}</p>}
      {setup.map((w) => (
        <p key={keyOf(w)} className="hint">
          {w.label}: {w.hint ?? "needs setting up on the server."}{" "}
          {w.href && (
            <a className="int-link" href={w.href} target="_blank" rel="noopener noreferrer">
              How
              <ExternalLink className="icon-xs" aria-hidden="true" />
            </a>
          )}
        </p>
      ))}
      {way.needs ? (
        <>
          <p className="hint">{way.needs.text}</p>
          <div className="rowx">
            <a className="btn btn-secondary btn-sm" href={way.needs.href}>
              Open Settings
            </a>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Close
            </button>
          </div>
        </>
      ) : way.auth === "oauth" ? (
        <SignIn
          key={keyOf(way)}
          way={way}
          question={instead ? `Orders paid at ${card.title} instead of ${instead}.` : undefined}
          onCancel={onCancel}
          onError={onError}
        />
      ) : way.auth === "link" ? (
        <MakeLink
          way={way}
          pending={pending}
          error={error}
          onCancel={onCancel}
          onMake={() => onConnect(body(way, {}), way)}
        />
      ) : (
        <WayForm
          key={keyOf(way)}
          way={way}
          email={email}
          pending={pending}
          error={error}
          question={
            instead
              ? card.group === "shops"
                ? `Orders paid at ${card.title} instead of ${instead}?`
                : `Send links from ${card.title} instead of ${instead}?`
              : undefined
          }
          onCancel={onCancel}
          onSubmit={(values) => onConnect(body(way, values), way)}
        />
      )}
      {(others.length > 0 || way.advanced) && (
        <details className="advanced">
          <summary className="disclosure">
            <ChevronRight className="icon-sm disclosure-icon" aria-hidden="true" />
            <span className="disclosure-open">Fewer options</span>
            <span className="disclosure-closed">More options</span>
          </summary>
          <div className="advanced-body stack-xs">
            {way.advanced && preferred.way && (
              <button type="button" className="int-inline" onClick={() => setPicked(null)}>
                Back to {preferred.way.label}
              </button>
            )}
            {others.map((w) => (
              <button key={keyOf(w)} type="button" className="int-inline" onClick={() => setPicked(keyOf(w))}>
                {w.label}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** A link the inbox makes (a calendar of your bookings for another platform): one press. */
function MakeLink({
  way,
  pending,
  error,
  onMake,
  onCancel,
}: {
  way: GalleryWay;
  pending: boolean;
  error: ApiProblem | null;
  onMake: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="stack">
      {way.note && <p className="hint">{way.note}</p>}
      {way.steps && way.steps.length > 0 && (
        <ol className="int-steps">
          {way.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {error && (
        <p className="hint error" role="alert">
          {error.detail}
        </p>
      )}
      <div className="rowx">
        <button type="button" className="btn btn-primary" disabled={pending} onClick={onMake}>
          {pending ? "Making…" : way.action}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function keyOf(w: GalleryWay | undefined): string {
  return w ? `${w.kind}:${w.preset ?? ""}` : "";
}

/**
 * A sign-in on the platform, or an approval on the owner's own store: what it will ask, what it needs
 * first (the store's address, filled in from the business's website), and one button.
 */
function SignIn({
  way,
  again,
  question,
  onCancel,
  onError,
}: {
  way: GalleryWay;
  again?: boolean;
  question?: string | undefined;
  onCancel: () => void;
  onError: (t: string) => void;
}) {
  const [going, setGoing] = useState(false);
  const before = way.before ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(before.filter((f) => f.value).map((f) => [f.key, f.value ?? ""])),
  );
  const missing = before.some((f) => f.required && !(values[f.key] ?? "").trim());
  return (
    <div className="stack">
      {way.consent && <p className="hint">{way.consent}</p>}
      {before.map((f) => (
        <div key={f.key} className="int-field">
          <Field id={`int-before-${f.key}`} label={f.label} hint={f.help} optional={!f.required}>
            <input
              id={`int-before-${f.key}`}
              className="input"
              type="text"
              inputMode={f.input === "url" ? "url" : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </Field>
        </div>
      ))}
      {question && <p className="hint int-question">{question}</p>}
      <div className="rowx">
        <button
          type="button"
          className="btn btn-primary"
          disabled={going || missing}
          onClick={async () => {
            setGoing(true);
            try {
              const { authorize_url } = await api.authorizeIntegration({
                kind: way.kind,
                ...(way.preset ? { preset: way.preset } : {}),
                ...(before.length > 0
                  ? { input: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])) }
                  : {}),
              });
              window.location.assign(authorize_url);
            } catch (e) {
              setGoing(false);
              onError(problemOf(e).detail);
            }
          }}
        >
          {going ? "Opening…" : again ? `Connect again with ${way.label}` : way.action}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A secret field is never filled in by a browser or a password manager: beside an email field,
 * Safari and iCloud Keychain take the form for a sign-up and offer a password of their own, which
 * is not the app password made for this inbox.
 */
const NO_FILL = {
  autoComplete: "off",
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

function WayForm({
  way,
  email,
  account,
  mode,
  question,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  way: GalleryWay;
  email?: string | null;
  /** Connecting again: the account, as it is connected; only the secret fields are asked for. */
  account?: string;
  /** A payment platform's key for this mode: its placeholder says which ("rk_test_…"). */
  mode?: "live" | "test" | undefined;
  /** Asked above the buttons, answered by them: "Send links from Stripe instead of Mollie?" */
  question?: string | undefined;
  submitLabel?: string | undefined;
  pending: boolean;
  error: ApiProblem | null;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const fields = account !== undefined ? way.form.filter((f) => f.secret) : way.form;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const first: Record<string, string> = {};
    // The owner's own address, editable: the calendar's account is most often it.
    if (email && account === undefined)
      for (const f of fields) if (f.input === "email" && !f.secret) first[f.key] = email;
    return first;
  });
  const main = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  const missing = main.some((f) => f.required && !(values[f.key] ?? "").trim());
  const fieldError = (f: FormField) => error?.field(`values.${f.key}`);
  const shown = new Set(fields.map((f) => `values.${f.key}`));
  const general = error && !(error.fields ?? []).some((f) => shown.has(f.path));
  const input = (f: FormField) => (
    <div key={f.key} className="int-field">
      <Field id={`int-${f.key}`} label={f.label} hint={f.help} error={fieldError(f)} optional={!f.required}>
        <input
          id={`int-${f.key}`}
          className="input"
          type={f.input === "url" ? "text" : f.input}
          inputMode={f.input === "url" ? "url" : f.input === "email" ? "email" : undefined}
          {...(f.secret ? NO_FILL : { autoComplete: f.autocomplete ?? "off" })}
          spellCheck={false}
          placeholder={(mode && f.byMode?.[mode]) || f.placeholder}
          value={values[f.key] ?? ""}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          required={f.required}
        />
      </Field>
      {f.steps && f.steps.length > 0 && (
        <ol className="int-steps">
          {f.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
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
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
      }}
    >
      {account !== undefined ? (
        <p className="int-account-line">{account}</p>
      ) : (
        way.note && <p className="hint">{way.note}</p>
      )}
      {main.map(input)}
      {advanced.length > 0 && (
        <details className="advanced">
          <summary className="disclosure">
            <ChevronRight className="icon-sm disclosure-icon" aria-hidden="true" />
            <span className="disclosure-open">Fewer options</span>
            <span className="disclosure-closed">More options</span>
          </summary>
          <div className="advanced-body stack">
            {advanced.map(input)}
            {way.hook && <HookAddress hook={way.hook} />}
          </div>
        </details>
      )}
      {general && (
        <p className="hint error" role="alert">
          {error.detail}
        </p>
      )}
      {question && <p className="hint int-question">{question}</p>}
      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={pending || missing}>
          {pending ? "Checking…" : (submitLabel ?? (account !== undefined ? "Connect again" : "Connect"))}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Where a payment platform sends what it says, for an owner who adds the webhook by hand: the
 * address, ready to copy, and the events to tick.
 */
function HookAddress({ hook }: { hook: { readonly url: string; readonly events: readonly string[] } }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="int-hook stack-xs">
      <span className="label">Webhook address</span>
      <span className="int-hook-row">
        <code className="int-hook-url">
          {hook.url.split("/").map((part, i, all) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one address, in order.
            <Fragment key={i}>
              {part}
              {i < all.length - 1 && (
                <>
                  /<wbr />
                </>
              )}
            </Fragment>
          ))}
        </code>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          aria-label={copied ? "Address copied" : "Copy the address"}
          onClick={() => void navigator.clipboard.writeText(hook.url).then(() => setCopied(true))}
        >
          {copied ? <Check className="icon-xs" aria-hidden="true" /> : <Copy className="icon-xs" aria-hidden="true" />}
        </button>
      </span>
      <span className="hint">Events: {hook.events.join(", ")}</span>
    </div>
  );
}

const STATUS: Record<string, string> = {
  configured: "Reading…",
  active: "Connected",
  error: "Failing",
  disabled: "Paused",
};

/** "synced just now", "synced 24 min ago": a few words that read as a sentence. */
function syncedAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "synced just now";
  const m = Math.round(s / 60);
  if (m < 60) return `synced ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `synced ${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `synced ${d} days ago`;
}

function dayOf(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(ms));
}

function ConnectionLine({
  connection: c,
  connections,
  cards,
  onNotice,
}: {
  connection: ConnectionView;
  connections: readonly ConnectionView[];
  cards: readonly GalleryCard[];
  onNotice: (n: Notice) => void;
}) {
  const write = useIntegrationWrite();
  const [panel, setPanel] = useState<"change" | "again" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const destination = c.destinations.find((d) => d.id === c.destination);
  const writes = c.capabilities.includes("write_bookings");
  const way = cards
    .find((card) => card.id === cardOf(c))
    ?.ways.find((w) => w.kind === c.kind && (w.preset ?? null) === (c.preset ?? null));
  const pays = c.payments;
  const disconnecting = pays?.disconnecting === true;
  // A connection that is a link the inbox serves (a calendar to import elsewhere): nothing to sync.
  const serves = c.capabilities.length === 0;
  const products = c.catalogue
    ? `${c.catalogue.products} ${c.catalogue.products === 1 ? "product" : "products"}${c.catalogue.truncated ? " (the first ones)" : ""}`
    : null;
  // Which platform sends an order's links, said only where there is a choice: the default is not news.
  const sender = connections.find(
    (o) => o.id !== c.id && o.payments && o.pay_on && o.mode === c.mode && !o.payments.disconnecting,
  );
  const several = connections.filter((o) => o.payments).length > 1;
  const meta = serves
    ? [
        c.status === "configured"
          ? "not opened yet"
          : c.last_sync_at
            ? `opened ${syncedAgo(c.last_sync_at, Date.now()).replace(/^synced /, "")}`
            : null,
      ].filter(Boolean)
    : pays
      ? [
          products,
          c.mode === "test" ? "test key · links only for orders made in Test mode" : null,
          disconnecting
            ? `switching off ${pays.closing} ${pays.closing === 1 ? "link" : "links"}`
            : !c.pay_on
              ? sender
                ? `not used: ${sender.title} sends your links`
                : "links off"
              : several
                ? "sends your links"
                : null,
          pays.open > 0 ? `${pays.open} waiting` : null,
          pays.held && pays.held > 0 ? `${pays.held} not sent: the shop counts another total` : null,
          pays.paid > 0 ? `${pays.paid} paid` : null,
          c.last_sync_at && !disconnecting ? syncedAgo(c.last_sync_at, Date.now()) : null,
        ].filter(Boolean)
      : [
          c.busy_on
            ? c.status === "configured"
              ? "reading busy times"
              : `${c.busy_times} busy ${c.busy_times === 1 ? "time" : "times"} ahead`
            : "busy times off",
          writes
            ? c.bookings_on
              ? destination && c.kind !== "calcom"
                ? `bookings go to ${destination.name}`
                : "bookings go out"
              : "bookings off"
            : null,
          c.last_sync_at ? syncedAgo(c.last_sync_at, Date.now()) : null,
        ].filter(Boolean);
  const problem = write.error ? problemOf(write.error) : null;
  const failing = c.status === "error";
  return (
    <div className={clsx("int-conn row-glass", c.status === "disabled" && "is-paused")}>
      <div className="int-conn-main">
        <div className="int-conn-head">
          <span className="int-title">{c.title}</span>
          <span className="int-account">{c.account}</span>
          <span className={clsx("pill pill-xs", failing && "is-warn")}>
            {disconnecting
              ? "Disconnecting"
              : serves && c.status === "configured"
                ? "Made"
                : (STATUS[c.status] ?? c.status)}
          </span>
        </div>
        <div className="int-meta">
          {meta.join(" · ")}
          {pays?.dashboard_url && !disconnecting && (
            <a className="int-link int-open-link" href={pays.dashboard_url} target="_blank" rel="noopener noreferrer">
              Open {c.title}
              <ExternalLink className="icon-xs" aria-hidden="true" />
            </a>
          )}
        </div>
        {serves && c.link && <LinkLine link={c.link} />}
        {pays?.webhook === "pending" && !disconnecting && (
          <div className="hint">
            {c.title} tells this inbox of payments once it is live; until then the inbox asks {c.title} on each sync.
          </div>
        )}
        {failing && c.last_error && (
          <div className="hint error" role="alert">
            {c.last_error}
          </div>
        )}
        {c.busy_on && c.busy_partial && c.busy_until && (
          <div className="hint">
            Read to {dayOf(c.busy_until)}: this calendar has more ahead than is read, so later times stay closed.
          </div>
        )}
        {pays && pays.failing > 0 && !disconnecting && (
          <div className="hint error" role="alert">
            {pays.failing === 1
              ? "An order has no payment link: it shows on the order."
              : `${pays.failing} orders have no payment link: each shows on its order.`}
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
      {!disconnecting && (
        <div className="rowx int-actions">
          {serves ? null : failing && way?.status === "ready" ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={panel === "again"}
              onClick={() => setPanel(panel === "again" ? null : "again")}
            >
              Connect again
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`Sync ${c.title} now`}
              title="Sync now"
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
          )}
          {pays?.dashboard_url && (
            <a
              className="btn btn-ghost btn-sm int-open-btn"
              href={pays.dashboard_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {c.title}
              <ExternalLink className="icon-xs" aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={panel === "change"}
            onClick={() => setPanel(panel === "change" ? null : "change")}
          >
            {serves ? "New link" : "Change"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
            Disconnect
          </button>
        </div>
      )}
      {panel === "again" && way && (
        <div className="confirm row-glass wide stack int-panel">
          {pays && <h3>New key for {c.title}</h3>}
          {pays && <p className="hint">Paste the new key. Your orders and their links stay as they are.</p>}
          {way.auth === "oauth" ? (
            <SignIn
              way={way}
              again
              onCancel={() => setPanel(null)}
              onError={(text) => onNotice({ tone: "danger", text })}
            />
          ) : (
            <WayForm
              way={way}
              account={c.account}
              mode={c.mode ?? undefined}
              submitLabel={pays ? "Use this key" : undefined}
              pending={write.isPending}
              error={problem}
              onCancel={() => setPanel(null)}
              onSubmit={(values) =>
                write.mutate(
                  {
                    connect: {
                      kind: c.kind,
                      ...(c.preset ? { preset: c.preset } : {}),
                      connection_id: c.id,
                      values,
                    },
                  },
                  {
                    onSuccess: () => {
                      setPanel(null);
                      onNotice({
                        tone: "success",
                        text: pays ? `${c.title} uses the new key.` : "Connected again. Reading your calendar now.",
                      });
                    },
                  },
                )
              }
            />
          )}
        </div>
      )}
      {panel === "change" &&
        (serves ? (
          <NewLink connection={c} onDone={() => setPanel(null)} onNotice={onNotice} />
        ) : pays ? (
          <PayChoices connection={c} onNewKey={() => setPanel("again")} onNotice={onNotice} />
        ) : (
          <Choices connection={c} onDone={() => setPanel(null)} onNotice={onNotice} />
        ))}
      {confirming && (
        <div className="confirm row-glass wide">
          <h3>Disconnect {c.title}</h3>
          <p className="hint">
            {serves
              ? "The link stops working at once, wherever it was pasted."
              : pays
                ? `Links still waiting to be paid stop working. Payments already made stay in your ${c.title} account.${c.catalogue ? " Its products go off sale here." : ""}`
                : "Its busy times stop blocking at once. Bookings already added stay in the calendar."}
          </p>
          {c.disconnect_note && <p className="hint">{c.disconnect_note}</p>}
          <div className="rowx">
            <button
              type="button"
              className="btn btn-danger"
              disabled={write.isPending}
              onClick={() =>
                write.mutate(
                  { id: c.id, remove: true },
                  {
                    onSuccess: (r) => {
                      setConfirming(false);
                      const closing = (r as { links_closing?: number } | undefined)?.links_closing ?? 0;
                      onNotice({
                        tone: "success",
                        text:
                          closing > 0
                            ? `${c.title} is being disconnected: its links waiting to be paid are being switched off.`
                            : `${c.title} is disconnected.`,
                      });
                    },
                  },
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

/**
 * A payment platform's one choice, whether accepted orders get a link to pay, which applies at once;
 * and a new key for the same account.
 */
function PayChoices({
  connection: c,
  onNewKey,
  onNotice,
}: {
  connection: ConnectionView;
  onNewKey: () => void;
  onNotice: (n: Notice) => void;
}) {
  const write = useIntegrationWrite();
  return (
    <div className="confirm row-glass wide stack">
      <Switch
        checked={c.pay_on}
        onChange={(on) =>
          write.mutate(
            { id: c.id, patch: { pay_on: on } },
            {
              onSuccess: () =>
                onNotice({ tone: "success", text: on ? "Links to pay are on." : "Links to pay are off." }),
            },
          )
        }
      >
        Send a link to pay when you accept an order
      </Switch>
      <ChoiceFields connection={c} onNotice={onNotice} />
      <p className="hint">Refunds are made in {c.title}, from the payment's own page.</p>
      <div className="rowx">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onNewKey}>
          New key
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

/**
 * A payment platform's tile when it is connected (ADR-023): a new key for the connection there is,
 * never a second one of the same mode beside it; and, when only one mode is connected, a key of the
 * other ("Add a test key · links for test orders only").
 */
function PayKeyPanel({
  card,
  connections,
  onCancel,
  onNotice,
}: {
  card: GalleryCard;
  connections: readonly ConnectionView[];
  onCancel: () => void;
  onNotice: (n: Notice) => void;
}) {
  const write = useIntegrationWrite();
  const way = card.ways.find((w) => w.status === "ready");
  const kept = connections.filter((c) => !c.payments?.disconnecting);
  const [target, setTarget] = useState<string>(kept[0]?.id ?? "");
  const [adding, setAdding] = useState(false);
  if (!way) return null;
  if (kept.length === 0) {
    return (
      <div className="confirm row-glass stack int-panel">
        <p className="hint">
          {card.title} is being disconnected: its links waiting to be paid are being switched off. Connect it again once
          that is done.
        </p>
        <div className="rowx">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }
  const current = kept.find((c) => c.id === target) ?? kept[0];
  const other: "live" | "test" | null =
    kept.some((c) => c.mode === "live") && kept.some((c) => c.mode === "test")
      ? null
      : kept[0]?.mode === "test"
        ? "live"
        : "test";
  const problem = write.error ? problemOf(write.error) : null;
  if (adding && other) {
    return (
      <div className="confirm row-glass stack int-panel">
        <h3>{other === "test" ? `A test key for ${card.title}` : `A live key for ${card.title}`}</h3>
        <p className="hint">
          {other === "test"
            ? "Links for orders made in Test mode only. Your live key stays as it is."
            : "Links for real orders. Your test key stays for orders made in Test mode."}
        </p>
        <WayForm
          way={{ ...way, form: way.form.filter((f) => !f.advanced) }}
          mode={other}
          pending={write.isPending}
          error={problem}
          onCancel={() => setAdding(false)}
          onSubmit={(values) =>
            write.mutate(
              { connect: { kind: way.kind, values } },
              {
                onSuccess: () =>
                  onNotice({
                    tone: "success",
                    text:
                      other === "test" ? `Test orders get a ${card.title} test link.` : `${card.title} is connected.`,
                  }),
              },
            )
          }
        />
      </div>
    );
  }
  if (!current) return null;
  return (
    <div className="confirm row-glass stack int-panel">
      <h3>New key for {card.title}</h3>
      <p className="hint">Paste the new key. Your orders and their links stay as they are.</p>
      {kept.length > 1 && (
        <fieldset className="seg">
          <legend className="sr-only">Which key</legend>
          {kept.map((c) => (
            <button key={c.id} type="button" aria-pressed={c.id === current.id} onClick={() => setTarget(c.id)}>
              {c.mode === "test" ? "Test key" : "Live key"}
            </button>
          ))}
        </fieldset>
      )}
      <WayForm
        key={current.id}
        way={way}
        account={current.account}
        mode={current.mode ?? undefined}
        submitLabel="Use this key"
        pending={write.isPending}
        error={problem}
        onCancel={onCancel}
        onSubmit={(values) =>
          write.mutate(
            { connect: { kind: way.kind, connection_id: current.id, values } },
            { onSuccess: () => onNotice({ tone: "success", text: `${card.title} uses the new key.` }) },
          )
        }
      />
      {other && (
        <button type="button" className="int-inline int-add-mode" onClick={() => setAdding(true)}>
          {other === "test" ? "Add a test key · links for test orders only" : "Add a live key · links for real orders"}
        </button>
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
        Block times you are busy
      </Switch>
      {busyOn && c.calendars.length > 1 && (
        <fieldset className="chips-field">
          <legend className="label">Busy in</legend>
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
          <legend className="label">Blocks</legend>
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
      <ChoiceFields connection={c} onNotice={onNotice} />
      {bookingsOn && writable.length > 1 && (
        <Field id={`dest-${c.id}`} label={c.kind === "calcom" ? "Event type" : "To"}>
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

/**
 * What else a connection lets the owner choose (a till's location, a team member), drawn from what the
 * server says: a chooser each, saved as soon as it changes. Never a typed id.
 */
function ChoiceFields({ connection: c, onNotice }: { connection: ConnectionView; onNotice: (n: Notice) => void }) {
  const write = useIntegrationWrite();
  if (!c.choices || c.choices.length === 0) return null;
  return (
    <>
      {c.choices.map((choice) => (
        <Field key={choice.key} id={`choice-${c.id}-${choice.key}`} label={choice.label}>
          <select
            id={`choice-${c.id}-${choice.key}`}
            className="input"
            value={choice.value ?? ""}
            disabled={write.isPending}
            onChange={(e) =>
              write.mutate(
                { id: c.id, patch: { choices: { [choice.key]: e.target.value || null } } },
                { onSuccess: () => onNotice({ tone: "success", text: "Saved." }) },
              )
            }
          >
            <option value="">None</option>
            {choice.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
      ))}
    </>
  );
}

/** A link a connection serves, read-only, with Copy: the owner pastes it into another platform. */
function LinkLine({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="int-hook stack-xs">
      <span className="int-hook-row">
        <code className="int-hook-url">{link}</code>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          aria-label={copied ? "Link copied" : "Copy the link"}
          onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
        >
          {copied ? <Check className="icon-xs" aria-hidden="true" /> : <Copy className="icon-xs" aria-hidden="true" />}
        </button>
      </span>
    </div>
  );
}

/** A new link in place of the old one, which stops at once wherever it was pasted. */
function NewLink({
  connection: c,
  onDone,
  onNotice,
}: {
  connection: ConnectionView;
  onDone: () => void;
  onNotice: (n: Notice) => void;
}) {
  const write = useIntegrationWrite();
  return (
    <div className="confirm row-glass wide stack">
      <p className="hint">The old link stops working at once. Paste the new one where the old one was.</p>
      <div className="rowx">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={write.isPending}
          onClick={() =>
            write.mutate(
              { id: c.id, link: true },
              {
                onSuccess: () => {
                  onDone();
                  onNotice({ tone: "success", text: "A new link is made. Copy it from its line." });
                },
              },
            )
          }
        >
          Make a new link
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
