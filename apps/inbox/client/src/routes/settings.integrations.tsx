import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Check, Copy, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, SectionHead, Switch } from "../components/Form";
import { type ApiProblem, problemOf } from "../lib/api";
import { relativeTime } from "../lib/format";
import {
  useCreateWebhook,
  useFeeds,
  useFeedWrite,
  useRotateSecret,
  useTestWebhook,
  useWebhooks,
  useWebhookWrite,
} from "../lib/queries";
import type { CreateWebhookBody, FeedConnector, TestEventResult, WebhookView, WebhookWithSecret } from "../lib/types";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsPage,
});

/**
 * Integrations: what comes in, and where events go. Two halves that never meet — a feed fills the
 * catalogue, a webhook carries what happens to it — but they are the same question for an owner,
 * which is "is this inbox talking to the rest of my shop".
 */
function IntegrationsPage() {
  return (
    <>
      <FeedsCard />
      <WebhooksCard />
    </>
  );
}

/* --- Product feeds ------------------------------------------------------- */

function FeedsCard() {
  const feeds = useFeeds();
  const write = useFeedWrite();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = feeds.data?.items ?? [];
  const problem = write.error ? problemOf(write.error) : null;

  const done = (text: string) => {
    setAdding(false);
    setConfirm(null);
    setNotice(text);
  };

  return (
    <section className="card glass stack">
      <SectionHead title="Product feeds">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            write.reset();
            setNotice(null);
            setAdding(true);
          }}
        >
          <Plus className="icon" aria-hidden="true" />
          Connect a feed
        </button>
      </SectionHead>
      <p className="lede small">
        A feed is a URL your shop already publishes, usually for Google. Paste it and the catalogue fills itself, then
        keeps up on its own. There is no password to hand over and nothing to install.
      </p>
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      {feeds.isPending && <div className="skeleton sk-line" />}
      {feeds.isError && (
        <ErrorState
          title="Could not load the feeds"
          text={problemOf(feeds.error).detail}
          onRetry={() => void feeds.refetch()}
        />
      )}
      {feeds.isSuccess && rows.length === 0 && !adding && (
        <div className="state">
          <h3>No feed connected</h3>
          <p>If your shop publishes a product feed, this is the fastest way to give agents a real catalogue.</p>
        </div>
      )}
      {adding && (
        <FeedForm
          pending={write.isPending}
          error={problem}
          onCancel={() => setAdding(false)}
          onSubmit={(body) =>
            write.mutate({ body }, { onSuccess: () => done("Feed connected. The first import is running now.") })
          }
        />
      )}
      <div className="stack">
        {rows.map((feed) => (
          <FeedLine
            key={feed.id}
            feed={feed}
            confirming={confirm === feed.id}
            pending={write.isPending}
            error={confirm === feed.id ? problem : null}
            onImport={() =>
              write.mutate({ id: feed.id }, { onSuccess: () => done("Importing now. Give it a moment, then refresh.") })
            }
            onAskRemove={() => {
              write.reset();
              setNotice(null);
              setConfirm(feed.id);
            }}
            onRemove={() =>
              write.mutate(
                { id: feed.id, remove: true },
                {
                  onSuccess: (result) => {
                    const n = "deactivated" in result ? result.deactivated : 0;
                    done(`${feed.name} disconnected. ${n} product${n === 1 ? "" : "s"} taken off sale, none deleted.`);
                  },
                },
              )
            }
            onKeep={() => setConfirm(null)}
          />
        ))}
      </div>
    </section>
  );
}

function FeedLine({
  feed,
  confirming,
  pending,
  error,
  onImport,
  onAskRemove,
  onRemove,
  onKeep,
}: {
  feed: FeedConnector;
  confirming: boolean;
  pending: boolean;
  error: ApiProblem | null;
  onImport: () => void;
  onAskRemove: () => void;
  onRemove: () => void;
  onKeep: () => void;
}) {
  const failing = feed.status === "error";
  const meta = [
    `${feed.product_count} product${feed.product_count === 1 ? "" : "s"}`,
    feed.last_sync_at ? `imported ${relativeTime(new Date(feed.last_sync_at).toISOString())}` : "not imported yet",
  ].join(" · ");
  return (
    <div className={clsx("catalogue-row row-glass", failing && "is-archived")}>
      <div className="catalogue-main">
        <div className="t">
          <b>{feed.name}</b>
          {failing && <span className="pill pill-xs">Failing</span>}
        </div>
        <div className="s">{meta}</div>
        <div className="s mono">{feed.url}</div>
        {failing && feed.last_error && (
          <div className="hint error" role="alert">
            {feed.last_error}
          </div>
        )}
      </div>
      <div className="rowx">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onImport} disabled={pending}>
          <RefreshCw className="icon" aria-hidden="true" />
          Import now
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onAskRemove} aria-expanded={confirming}>
          Disconnect
        </button>
      </div>
      {confirming && (
        <div className="confirm row-glass wide">
          <h3>Disconnect {feed.name}</h3>
          <p className="hint">
            Its products stop being for sale. Nothing is deleted, so an order that points at one keeps its history, and
            reconnecting the same URL adopts them again rather than making a second copy.
          </p>
          {error && (
            <p className="hint error" role="alert">
              {error.detail}
            </p>
          )}
          <div className="rowx">
            <button type="button" className="btn btn-danger" onClick={onRemove} disabled={pending}>
              Disconnect feed
            </button>
            <button type="button" className="btn btn-ghost" onClick={onKeep} disabled={pending}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FeedForm({
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  error: ApiProblem | null;
  onSubmit: (body: { url: string; name?: string | undefined; deactivate_missing: boolean }) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [deactivate, setDeactivate] = useState(true);
  return (
    <form
      className="confirm row-glass stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ url: url.trim(), name: name.trim() || undefined, deactivate_missing: deactivate });
      }}
    >
      <Field
        id="feed-url"
        label="Feed URL"
        hint="A comma-separated export or a Google Merchant XML feed. Your platform calls it a product feed or a Google Shopping feed."
        error={error?.field("url")}
      >
        <input
          id="feed-url"
          className="input"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="https://yourshop.example/feed.xml"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </Field>
      <Field id="feed-name" label="Name" optional hint="Defaults to the address it is fetched from.">
        <input
          id="feed-name"
          className="input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Main shop"
        />
      </Field>
      <Switch checked={deactivate} onChange={setDeactivate} disabled={pending}>
        Take a product off sale when it leaves the feed
      </Switch>
      {error && !error.field("url") && (
        <p className="hint error" role="alert">
          {error.detail}
        </p>
      )}
      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={pending || url.trim() === ""}>
          {pending ? "Connecting…" : "Connect and import"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* --- Webhooks ------------------------------------------------------------ */

const EVENT_CHOICES = [
  { pattern: "booking.*", label: "Bookings" },
  { pattern: "order.*", label: "Orders" },
  { pattern: "quote_request.*", label: "Quote requests" },
  { pattern: "message.*", label: "Messages" },
] as const;

function WebhooksCard() {
  const webhooks = useWebhooks();
  const create = useCreateWebhook();
  const write = useWebhookWrite();
  const test = useTestWebhook();
  const rotate = useRotateSecret();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<WebhookWithSecret | null>(null);
  const [tested, setTested] = useState<{ id: string; result: TestEventResult } | null>(null);
  const rows = webhooks.data?.items ?? [];
  const problem = create.error
    ? problemOf(create.error)
    : write.error
      ? problemOf(write.error)
      : rotate.error
        ? problemOf(rotate.error)
        : null;

  return (
    <section className="card glass stack">
      <SectionHead title="Where events go">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            create.reset();
            setNotice(null);
            setRevealed(null);
            setAdding(true);
          }}
        >
          <Plus className="icon" aria-hidden="true" />
          Add endpoint
        </button>
      </SectionHead>
      <p className="lede small">
        Every booking, order, quote and message is sent to the URLs here, signed so you can prove it came from this
        inbox. Point them at Zapier, n8n, Make, a Slack bot or your own server.
      </p>
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      {revealed && <SecretPanel webhook={revealed} onDone={() => setRevealed(null)} />}
      {webhooks.isPending && <div className="skeleton sk-line" />}
      {webhooks.isError && (
        <ErrorState
          title="Could not load the endpoints"
          text={problemOf(webhooks.error).detail}
          onRetry={() => void webhooks.refetch()}
        />
      )}
      {webhooks.isSuccess && rows.length === 0 && !adding && (
        <div className="state">
          <h3>Nothing is listening</h3>
          <p>Add a URL and this inbox will post every event to it, with a signature your code can check.</p>
        </div>
      )}
      {adding && (
        <WebhookForm
          pending={create.isPending}
          error={create.error ? problemOf(create.error) : null}
          onCancel={() => setAdding(false)}
          onSubmit={(body) =>
            create.mutate(body, {
              onSuccess: (created) => {
                setAdding(false);
                setRevealed(created);
              },
            })
          }
        />
      )}
      <div className="stack">
        {rows.map((hook) => (
          <WebhookLine
            key={hook.id}
            webhook={hook}
            confirming={confirm === hook.id}
            pending={write.isPending || test.isPending || rotate.isPending}
            error={confirm === hook.id ? problem : null}
            test={tested?.id === hook.id ? tested.result : null}
            onTest={() =>
              test.mutate(hook.id, {
                onSuccess: (result) => setTested({ id: hook.id, result }),
                onError: (e) => setNotice(problemOf(e).detail),
              })
            }
            onToggle={() =>
              write.mutate(
                { id: hook.id, body: { active: !hook.active } },
                {
                  onSuccess: () => {
                    setNotice(hook.active ? "Endpoint paused. Nothing is sent to it." : "Endpoint resumed.");
                  },
                },
              )
            }
            onRotate={() =>
              rotate.mutate(hook.id, {
                onSuccess: (rotated) => {
                  setRevealed(rotated);
                  setNotice(null);
                },
              })
            }
            onAskRemove={() => {
              write.reset();
              setNotice(null);
              setConfirm(hook.id);
            }}
            onRemove={() =>
              write.mutate(
                { id: hook.id, remove: true },
                {
                  onSuccess: () => {
                    setConfirm(null);
                    setNotice("Endpoint removed, with its delivery log.");
                  },
                },
              )
            }
            onKeep={() => setConfirm(null)}
          />
        ))}
      </div>
    </section>
  );
}

/** The secret, shown once. There is no second chance to read it, so the panel says so plainly. */
function SecretPanel({ webhook, onDone }: { webhook: WebhookWithSecret; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="confirm row-glass">
      <h3>Store this signing secret now</h3>
      <p className="hint">
        {webhook.secret_note ||
          "This is the only time it is shown. It cannot be read back, and without it your code cannot check that an event really came from here."}
      </p>
      <div className="rowx">
        <code className="mono secret">{webhook.secret}</code>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(webhook.secret)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <Check className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {webhook.previous_secret_until && (
        <p className="hint">
          The old secret keeps working until {new Date(webhook.previous_secret_until).toLocaleString()}, so you can
          change it over without dropping a delivery.
        </p>
      )}
      <div className="rowx">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I have stored it
        </button>
      </div>
    </div>
  );
}

function WebhookLine({
  webhook: w,
  confirming,
  pending,
  error,
  test,
  onTest,
  onToggle,
  onRotate,
  onAskRemove,
  onRemove,
  onKeep,
}: {
  webhook: WebhookView;
  confirming: boolean;
  pending: boolean;
  error: ApiProblem | null;
  test: TestEventResult | null;
  onTest: () => void;
  onToggle: () => void;
  onRotate: () => void;
  onAskRemove: () => void;
  onRemove: () => void;
  onKeep: () => void;
}) {
  const d = w.deliveries;
  const meta = [
    w.events.join(", "),
    w.payload_style === "full" ? "full payloads" : "thin payloads",
    `${d.delivered} delivered`,
    d.pending > 0 ? `${d.pending} waiting` : null,
    d.failed > 0 ? `${d.failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={clsx("catalogue-row row-glass", !w.active && "is-archived")}>
      <div className="catalogue-main">
        <div className="t">
          <b className="mono">{w.url}</b>
          {!w.active && <span className="pill pill-xs">Paused</span>}
          {w.active && w.failing_since && <span className="pill pill-xs">Failing</span>}
        </div>
        <div className="s">{meta}</div>
        {w.last_error && (
          <div className="hint error" role="alert">
            {w.last_error}
          </div>
        )}
        {test && (
          <div className={clsx("hint", !test.delivered && "error")} role="status">
            {test.delivered
              ? `Test delivered: answered ${test.status} in ${test.duration_ms}ms.`
              : `Test refused: ${test.error ?? `answered ${test.status ?? "nothing"}`}.`}
          </div>
        )}
      </div>
      <div className="rowx">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onTest} disabled={pending}>
          Send test
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onToggle} disabled={pending}>
          {w.active ? "Pause" : "Resume"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRotate} disabled={pending}>
          New secret
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onAskRemove} aria-expanded={confirming}>
          Remove
        </button>
      </div>
      {confirming && (
        <div className="confirm row-glass wide">
          <h3>Remove this endpoint</h3>
          <p className="hint">
            Nothing more is sent to it, and its delivery log goes with it. The events themselves stay.
          </p>
          {error && (
            <p className="hint error" role="alert">
              {error.detail}
            </p>
          )}
          <div className="rowx">
            <button type="button" className="btn btn-danger" onClick={onRemove} disabled={pending}>
              Remove endpoint
            </button>
            <button type="button" className="btn btn-ghost" onClick={onKeep} disabled={pending}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WebhookForm({
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  error: ApiProblem | null;
  onSubmit: (body: CreateWebhookBody) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [everything, setEverything] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [full, setFull] = useState(false);
  const events = everything ? ["*"] : chosen;
  return (
    <form
      className="confirm row-glass stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ url: url.trim(), events, payload_style: full ? "full" : "thin" });
      }}
    >
      <Field
        id="hook-url"
        label="Endpoint URL"
        hint="An https URL on a public host. Every event is POSTed here and signed."
        error={error?.field("url")}
      >
        <input
          id="hook-url"
          className="input"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="https://your-server.example/inbox-events"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </Field>
      <div>
        <span className="label">What to send</span>
        <Switch checked={everything} onChange={setEverything} disabled={pending}>
          Everything
        </Switch>
        {!everything && (
          <div className="stack sub">
            {EVENT_CHOICES.map((choice) => (
              <Switch
                key={choice.pattern}
                checked={chosen.includes(choice.pattern)}
                disabled={pending}
                onChange={(on) =>
                  setChosen((prev) =>
                    on ? [...prev, choice.pattern] : prev.filter((pattern) => pattern !== choice.pattern),
                  )
                }
              >
                {choice.label}
              </Switch>
            ))}
          </div>
        )}
        {error?.field("events") && (
          <div className="hint error" role="alert">
            {error.field("events")}
          </div>
        )}
      </div>
      <Switch checked={full} onChange={setFull} disabled={pending}>
        Send the whole item, not just a link to it
      </Switch>
      <p className="hint">
        A thin payload carries the item's id, state and a URL to fetch it, so a retry is never out of date and no
        customer's details are copied to a server you pasted once. Turn this on only if you need everything inline.
      </p>
      {error && !error.field("url") && !error.field("events") && (
        <p className="hint error" role="alert">
          {error.detail}
        </p>
      )}
      <div className="rowx">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || url.trim() === "" || events.length === 0}
        >
          {pending ? "Adding…" : "Add endpoint"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
