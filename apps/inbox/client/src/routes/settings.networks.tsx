import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, SectionHead, Switch } from "../components/Form";
import { type ApiProblem, problemOf } from "../lib/api";
import { hostOf, MAX_NETWORKS, networkStatus, parseNetworkOrigin, receiptWords } from "../lib/networks";
import { qk, useNetworks, useSaveSettings, useSettings } from "../lib/queries";
import type { NetworkView } from "../lib/types";

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

  const change = (
    origin: string,
    entry: { enabled: boolean } | null,
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
  const reload = () => {
    save.reset();
    void qc.invalidateQueries({ queryKey: qk.settings });
    void qc.invalidateQueries({ queryKey: qk.networks });
  };

  return (
    <section className="card glass stack">
      <SectionHead title="Networks" />
      <p className="lede small">Your inbox can report to several networks. Each one lists you in its own directory.</p>
      <p className="hint">
        A network you switch on gets your inbox's address, a count of new bookings, orders, quotes and messages every
        hour, and every receipt your inbox signs. Receipts name customers by a pseudonym only: no names, email addresses
        or messages leave your inbox.
      </p>
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
              change(
                n.origin,
                { enabled: on },
                on
                  ? `${hostOf(n.origin)} is on. Your inbox reports to it within a minute.`
                  : `${hostOf(n.origin)} is off. Nothing more is sent to it; switch it on again to send what it missed.`,
              )
            }
            onRemove={() => change(n.origin, null, `${hostOf(n.origin)} removed from the list.`)}
          />
        ))}
      </div>
      {networks.isSuccess && (
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
    </section>
  );
}

function NetworkLine({
  network: n,
  pending,
  error,
  onToggle,
  onRemove,
}: {
  network: NetworkView;
  pending: boolean;
  error: ApiProblem | null;
  onToggle: (on: boolean) => void;
  onRemove: () => void;
}) {
  const status = networkStatus(n);
  const counts = n.share.receipts && (n.enabled || n.receipts.published > 0) ? receiptWords(n.receipts) : [];
  return (
    <div className={clsx("catalogue-row row-glass", !n.enabled && "is-archived")}>
      <div className="catalogue-main">
        <Switch checked={n.enabled} onChange={onToggle} disabled={pending}>
          <b className="mono">{n.origin}</b>
        </Switch>
        <div className="s net-status">
          <i className={clsx("dot", status.tone !== "neutral" && `dot-${status.tone}`)} aria-hidden="true" />
          {status.line}
        </div>
        {status.detail && <div className="hint">{status.detail}</div>}
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
        {!n.enabled && (
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
