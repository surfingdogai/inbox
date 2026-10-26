import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, SectionHead, Switch } from "../components/Form";
import { type ApiProblem, api, problemOf } from "../lib/api";
import { catalogueBlockedWords, catalogueStatusLine, catalogueSwitchLocked, catalogueToast } from "../lib/catalogue";
import {
  carriedWords,
  type DoorPanel,
  doorPanel,
  emailWords,
  hostOf,
  MAX_NETWORKS,
  NETWORKS_WHY,
  networkStatus,
  parseNetworkOrigin,
  receiptWords,
  rulesWords,
  standingWords,
} from "../lib/networks";
import { qk, useCatalogue, useNetworks, useSaveSettings, useSettings } from "../lib/queries";
import type { CatalogueStatus, NetworkView } from "../lib/types";

export const Route = createFileRoute("/settings/networks")({
  component: NetworksPage,
});

interface Notice {
  readonly tone: "success" | "danger";
  readonly text: string;
}

/**
 * Settings → Networks (ADR-017 §8.1): the directories this inbox reports to. Each change is one
 * key of `networks` sent on its own — a merge, so the others are never touched — and switching a
 * network off keeps it in the list, with its receipts waiting for it.
 */
function NetworksPage() {
  const settings = useSettings();
  const networks = useNetworks();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  // Which row, or the add form, the last change came from: its error is shown there.
  const [acting, setActing] = useState<string | null>(null);
  const problem = save.error ? problemOf(save.error) : null;
  const conflict = problem?.code === "version_conflict";
  const rows = networks.data?.networks ?? [];
  // A host that holds the networks (a hosted inbox before it is live at its own address): no network
  // is added meanwhile, and each one's switch says whether it comes on when the inbox is live.
  const held = (settings.data?.locked ?? []).some((l) => l === "networks" || l.startsWith("networks."));

  const change = (
    origin: string,
    /**
     * One network's keys to change, merged into what is stored; null removes the network. `resume`,
     * while the host holds it: whether it comes on when the inbox is live.
     */
    entry: { enabled?: boolean; issue?: boolean; resume?: boolean; share?: { catalogue: boolean } } | null,
    done: string,
    from: string = origin,
    after?: () => void,
  ) => {
    if (!settings.data || save.isPending) return;
    save.reset();
    setNotice(null);
    setActing(from);
    save.mutate(
      { doc: { networks: { [origin]: entry } }, expected_version: settings.data.version },
      {
        onSuccess: () => {
          setActing(null);
          setNotice({ tone: "success", text: done });
          after?.();
        },
      },
    );
  };
  // One switch for every network at once: the manifest says it, so every network reads the same.
  const carriedOn = settings.data ? settings.data.doc.carried.accepted : true;
  const setCarried = (on: boolean) => {
    if (!settings.data || save.isPending) return;
    save.reset();
    setNotice(null);
    setActing("carried");
    save.mutate(
      { doc: { carried: { accepted: on } }, expected_version: settings.data.version },
      {
        onSuccess: () => {
          setActing(null);
          setNotice({
            tone: "success",
            text: on
              ? "On. Within five minutes, assistants can reach you through networks."
              : "Off. Within five minutes, networks stop bringing you assistants' requests; assistants can still write to your inbox directly.",
          });
        },
      },
    );
  };
  // Your products on networks (ADR-029): on unless the owner switches it off; the owner's alone.
  const catalogue = useCatalogue();
  const productsOn = settings.data ? settings.data.doc.catalogue.listed : true;
  const setCatalogue = (doc: { listed?: boolean; taxIncluded?: boolean | null }, done: string | null) => {
    if (!settings.data || save.isPending) return;
    save.reset();
    setNotice(null);
    setActing("catalogue");
    save.mutate(
      { doc: { catalogue: doc }, expected_version: settings.data.version },
      {
        onSuccess: () => {
          setActing(null);
          if (done) setNotice({ tone: "success", text: done });
        },
      },
    );
  };
  const reload = () => {
    save.reset();
    void qc.invalidateQueries({ queryKey: qk.settings });
    void qc.invalidateQueries({ queryKey: qk.networks });
  };

  return (
    <section className="card glass stack">
      <SectionHead title="Networks" />
      <div className="net-carried">
        <Switch checked={carriedOn} onChange={setCarried} disabled={save.isPending || !settings.data}>
          Requests from AI assistants
        </Switch>
        <div className="hint">
          Questions, quotes and booking requests that people's AI assistants send through Surfing Dog or another
          network, with the email they agreed to share. Off, assistants can still write to your inbox directly.
        </div>
        {acting === "carried" && problem && !conflict && (
          <div className="hint error" role="alert">
            {problem.detail}
          </div>
        )}
      </div>
      <ProductsOnNetworks
        on={productsOn}
        taxIncluded={settings.data ? settings.data.doc.catalogue.taxIncluded : null}
        status={catalogue.data}
        pending={save.isPending || !settings.data}
        error={acting === "catalogue" && problem && !conflict ? problem.detail : null}
        onSwitch={(on) => setCatalogue({ listed: on }, catalogueToast(on, catalogue.data))}
        onTax={(included) => setCatalogue({ taxIncluded: included }, null)}
      />
      <p className="lede small">{NETWORKS_WHY}</p>
      <details className="net-sent">
        <summary className="hint">What a network is sent</summary>
        <p className="hint">
          Your inbox's address, a count of new bookings, orders, quotes and messages every hour, and every receipt your
          inbox signs: each booking confirmed and order accepted, and how it ended. Receipts name customers by a
          pseudonym only: no names, messages or what was ordered.
        </p>
        <p className="hint">
          Customers' assistants may carry a pass from a network. Your inbox shows it to the network that issued it, with
          the customer's email, to learn whether the network knows them; you then see their standing there. With "Give
          first-time customers a key" on, a customer's first booking or order with an email sends that email to the
          network, which keeps only a keyed hash of it and gives your inbox a key to email to them. A network gets
          customers' email addresses only once it has verified your inbox. Test items never reach a network.
        </p>
        <p className="hint">
          With <i>Your products on networks</i> on: each product on sale here, as your own doors already show it (name,
          description, price, picture link, barcode, brand, in stock or not, its page on your site). Never your lowest
          prices, your costs, where a product was imported from, stock counts, or anything about customers.
        </p>
        <p className="hint">
          A network you switch on later gets your older receipts too. It counts a booking or an order whose promise
          reaches it more than a day late at half its weight, until the customer's assistant confirms it, so switching
          on early is what counts.
        </p>
      </details>
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      {conflict && (
        <Toast
          tone="danger"
          text="Settings changed somewhere else since you opened them."
          sub="Reload to see the latest, then make your change again."
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
              Reload
            </button>
          }
        />
      )}
      {networks.isPending && <div className="skeleton sk-line" />}
      {networks.isError && (
        <ErrorState
          title="Could not load the networks"
          text={problemOf(networks.error).detail}
          onRetry={() => void networks.refetch()}
        />
      )}
      {networks.isSuccess && rows.length === 0 && (
        <div className="state">
          <h3>No networks yet</h3>
          <p>Add one below and your inbox starts reporting to it within a minute.</p>
        </div>
      )}
      <div className="stack">
        {rows.map((n) => (
          <NetworkLine
            key={n.origin}
            network={n}
            pending={save.isPending}
            error={acting === n.origin && problem && !conflict ? problem : null}
            onToggle={(on) =>
              n.held
                ? change(
                    n.origin,
                    { resume: on },
                    on
                      ? `${hostOf(n.origin)} comes on as soon as your inbox is live at your own address.`
                      : `${hostOf(n.origin)} stays off when your inbox is live. Nothing is sent to it.`,
                  )
                : change(
                    n.origin,
                    { enabled: on },
                    on
                      ? `${hostOf(n.origin)} is on. Your inbox reports to it within a minute.`
                      : `${hostOf(n.origin)} is off. Nothing more is sent to it; switch it on again to send what it missed.`,
                  )
            }
            onIssue={(on) =>
              change(
                n.origin,
                { issue: on },
                on
                  ? `${hostOf(n.origin)} gives your first-time customers a key from now on.`
                  : `${hostOf(n.origin)} no longer gives your customers a key; nothing about a first-time customer goes to it.`,
              )
            }
            onRemove={() => change(n.origin, null, `${hostOf(n.origin)} removed from the list.`)}
            productsOn={productsOn}
            onProducts={(on) =>
              change(
                n.origin,
                { share: { catalogue: on } },
                on
                  ? `${hostOf(n.origin)} lists your products within an hour.`
                  : `${hostOf(n.origin)} stops showing your products now.`,
              )
            }
          />
        ))}
      </div>
      {networks.isSuccess && !held && (
        <AddNetwork
          existing={rows}
          pending={save.isPending || !settings.data}
          error={acting === "add" && problem && !conflict ? problem : null}
          onAdd={(origin, added) =>
            change(
              origin,
              { enabled: true },
              `${hostOf(origin)} added. Your inbox reports to it within a minute.`,
              "add",
              added,
            )
          }
        />
      )}
      {networks.isSuccess && <NewReceiptKey />}
    </section>
  );
}

/**
 * Making a new receipt key (`POST /v1/owner/receipt-keys/rotate`): folded away, for the day a copy
 * of the key may be in the wrong hands. The owner in person only, which is who is here.
 */
function NewReceiptKey() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const make = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await api.replaceReceiptKey();
      setNotice({ tone: "success", text: "A new key signs your receipts from now on." });
      void qc.invalidateQueries({ queryKey: qk.networks });
    } catch (error) {
      setNotice({ tone: "danger", text: problemOf(error).detail });
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="net-sent">
      <summary className="hint">The key your receipts are signed with</summary>
      <p className="hint">
        If a copy of it may be in the wrong hands, make a new one: your inbox signs with it from then on, and what the
        old one signed still verifies.
      </p>
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      <div className="rowx">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void make()} disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Make a new receipt key
        </button>
      </div>
    </details>
  );
}

/**
 * "Your products on networks" (ADR-029): one switch, on by default, with the tax chooser while it is
 * on, what the networks last said, and why it cannot work when it cannot.
 */
function ProductsOnNetworks({
  on,
  taxIncluded,
  status,
  pending,
  error,
  onSwitch,
  onTax,
}: {
  on: boolean;
  taxIncluded: boolean | null;
  status: CatalogueStatus | undefined;
  pending: boolean;
  error: string | null;
  onSwitch: (on: boolean) => void;
  onTax: (included: boolean) => void;
}) {
  const blocked = catalogueBlockedWords(status?.blocked ?? null);
  return (
    <div className="net-carried">
      <Switch
        checked={on}
        onChange={onSwitch}
        disabled={catalogueSwitchLocked({ on, blocked: status?.blocked ?? null, pending })}
      >
        Your products on networks
      </Switch>
      <div className="hint">
        Your products as you keep them here (name, price, picture, barcode, whether each is in stock) where people's AI
        assistants look, on the networks you report to. Orders still come to this inbox, at your price when they arrive.
      </div>
      {blocked && <div className="hint">{blocked}</div>}
      {on && !blocked && (
        <>
          <div className="chips net-tax" role="radiogroup" aria-label="Your prices and tax">
            <label className="chip">
              <input
                type="radio"
                name="tax"
                checked={taxIncluded === true}
                onChange={() => onTax(true)}
                disabled={pending}
              />
              <span>Your prices include tax</span>
            </label>
            <label className="chip">
              <input
                type="radio"
                name="tax"
                checked={taxIncluded === false}
                onChange={() => onTax(false)}
                disabled={pending}
              />
              <span>Your prices are before tax</span>
            </label>
          </div>
          {taxIncluded === null && <div className="hint">Until you choose, networks show "tax not said".</div>}
          {status && (
            <div className="s net-status">
              <i className="dot" aria-hidden="true" />
              <Link to="/settings/services">{catalogueStatusLine(status)}</Link>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="hint error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function NetworkLine({
  network: n,
  pending,
  error,
  onToggle,
  onIssue,
  onRemove,
  productsOn,
  onProducts,
}: {
  network: NetworkView;
  pending: boolean;
  error: ApiProblem | null;
  onToggle: (on: boolean) => void;
  onIssue: (on: boolean) => void;
  onRemove: () => void;
  /** Whether "Your products on networks" is on: each network's own share matters only then. */
  productsOn: boolean;
  onProducts: (on: boolean) => void;
}) {
  const status = networkStatus(n);
  const counts = n.share.receipts && (n.enabled || n.receipts.published > 0) ? receiptWords(n.receipts) : [];
  const rules = n.enabled ? rulesWords(n.rules) : null;
  const standing = standingWords(n);
  const doors = doorPanel(n);
  const carried = carriedWords(n);
  const emails = n.enabled ? emailWords(n) : null;
  return (
    <div className={clsx("catalogue-row row-glass net-row", !n.enabled && !n.held?.on_when_released && "is-archived")}>
      <div className="catalogue-main">
        <Switch checked={n.held ? n.held.on_when_released : n.enabled} onChange={onToggle} disabled={pending}>
          <b className="mono">{n.origin}</b>
        </Switch>
        <div className="s net-status">
          <i className={clsx("dot", status.tone !== "neutral" && `dot-${status.tone}`)} aria-hidden="true" />
          {status.line}
        </div>
        {status.detail && <div className="hint">{status.detail}</div>}
        {standing && (
          <div className="s net-status">
            <i className={clsx("dot", standing.tone !== "neutral" && `dot-${standing.tone}`)} aria-hidden="true" />
            Your standing here: {standing.line}
          </div>
        )}
        {doors && <AgentsGotOn panel={doors} />}
        {carried && <div className="hint">{carried}</div>}
        {rules && <div className="hint">{rules}</div>}
        {n.enabled && n.level === "directory" && (
          <div className="hint">
            A directory: it lists your business and keeps your receipts, but gives customers no keys, so your inbox
            never asks it for one.
          </div>
        )}
        {emails && n.level !== "directory" && <div className="hint">{emails}</div>}
        {n.enabled && n.level !== "directory" && (
          <div className="net-issue">
            <Switch checked={n.issue} onChange={onIssue} disabled={pending}>
              Give first-time customers a key
            </Switch>
            <div className="hint">
              On a first booking or order with an email and no pass, your inbox asks this network for a key and emails
              it to the customer, so any business on the network recognises them next time.
            </div>
          </div>
        )}
        {productsOn && n.share.listing && (
          <details className="net-sent">
            <summary className="hint">More</summary>
            <Switch checked={n.share.catalogue} onChange={onProducts} disabled={pending}>
              List my products here
            </Switch>
            {n.catalogue.error && <div className="hint">{n.catalogue.error}</div>}
          </details>
        )}
        {error && (
          <div className="hint error" role="alert">
            {error.detail}
          </div>
        )}
      </div>
      <div className="rowx">
        {counts.map((c) => (
          <span key={c} className="pill pill-xs">
            {c}
          </span>
        ))}
        {!n.enabled && !n.held && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} disabled={pending}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function AddNetwork({
  existing,
  pending,
  error,
  onAdd,
}: {
  existing: readonly NetworkView[];
  pending: boolean;
  error: ApiProblem | null;
  /** `added` runs once the server has taken it, so a refused address stays in the field to fix. */
  onAdd: (origin: string, added: () => void) => void;
}) {
  const [typed, setTyped] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const full = existing.length >= MAX_NETWORKS;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseNetworkOrigin(typed);
    if ("problem" in parsed) return setLocal(parsed.problem);
    const already = existing.find((n) => n.origin === parsed.origin);
    if (already) {
      return setLocal(already.enabled ? "That network is already on." : "That network is in the list: switch it on.");
    }
    setLocal(null);
    onAdd(parsed.origin, () => setTyped(""));
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Field
        id="net-add"
        label="Add a network"
        error={local ?? error?.detail}
        hint={
          full
            ? `That is ${MAX_NETWORKS} networks, the most an inbox reports to. Remove one that is off to add another.`
            : "Its https address, like https://network.example.com. It is switched on as soon as it is added."
        }
      >
        <div className="net-add">
          <input
            id="net-add"
            className="input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://network.example.com"
            value={typed}
            disabled={full}
            onChange={(e) => {
              setTyped(e.target.value);
              setLocal(null);
            }}
          />
          <button type="submit" className="btn btn-secondary" disabled={pending || full || typed.trim() === ""}>
            <Plus className="icon" aria-hidden="true" />
            Add network
          </button>
        </div>
      </Field>
    </form>
  );
}

/**
 * How agents got on at the business's own doors, as this network last said it (protocol §4.15):
 * folded away until opened, since it is detail. Open when something needs the owner.
 */
function AgentsGotOn({ panel }: { panel: DoorPanel }) {
  const urgent = panel.alerts.length > 0 || panel.doors.some((d) => d.check.tone === "danger");
  return (
    <details className="net-doors" open={urgent}>
      <summary className="s">
        How agents got on <span className="hint">· {panel.said}</span>
      </summary>
      {panel.alerts.map((a) => (
        <div key={a.line} className="s net-status">
          <i className={clsx("dot", `dot-${a.tone}`)} aria-hidden="true" />
          {a.line}
        </div>
      ))}
      {panel.doors.map((d) => (
        <div key={d.title} className="net-door">
          <div className="s mono">{d.title}</div>
          <div className="s net-status">
            <i className={clsx("dot", d.check.tone !== "neutral" && `dot-${d.check.tone}`)} aria-hidden="true" />
            {d.check.line}
          </div>
          {d.lines.map((line) => (
            <div key={line} className="hint">
              {line}
            </div>
          ))}
        </div>
      ))}
      {panel.fixes.length > 0 && (
        <ul className="net-fixes hint">
          {panel.fixes.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
