import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { SectionHead, Switch } from "../components/Form";
import { RuleEditor } from "../components/RuleEditor";
import { problemOf } from "../lib/api";
import { qk, useApplyPreset, usePresets, useProfile, useRules, useRuleWrite } from "../lib/queries";
import type { PresetKey, RuleView } from "../lib/types";

export const Route = createFileRoute("/settings/rules")({
  component: RulesPage,
});

type Editing = { readonly id: string | null } | null;

/**
 * What happens on its own: each rule as the sentence the engine lives by, a switch, and an editor
 * over the rule schema. Presets give a business its first rules in one click.
 */
function RulesPage() {
  const rules = useRules();
  const presets = usePresets();
  const profile = useProfile();
  const apply = useApplyPreset();
  const write = useRuleWrite();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmPreset, setConfirmPreset] = useState<PresetKey | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    text: string;
    sub?: string;
    reload?: boolean;
  } | null>(null);
  const currency = profile.data?.currency ?? "EUR";
  const items = rules.data?.items ?? [];
  const problem = write.error ? problemOf(write.error) : null;

  const reload = () => {
    setNotice(null);
    void qc.invalidateQueries({ queryKey: qk.rules });
  };
  const failed = (e: unknown, what: string) => {
    const p = problemOf(e);
    if (p.code === "version_conflict") {
      setNotice({
        tone: "danger",
        text: `${what} changed somewhere else since you opened this page.`,
        sub: "Reload to see the latest, then make your change again.",
        reload: true,
      });
    } else setNotice({ tone: "danger", text: `${what} was not saved.`, sub: p.detail });
  };
  const open = (next: Editing) => {
    write.reset();
    setNotice(null);
    setConfirmDelete(null);
    setEditing(next);
  };
  const applyPreset = (key: PresetKey, replace: boolean) =>
    apply.mutate(
      { key, replace },
      {
        onSuccess: (r) => {
          setConfirmPreset(null);
          setNotice({
            tone: "success",
            text: replace ? `Rules replaced: ${r.items.length} now.` : `Rules added: ${r.items.length} now.`,
          });
        },
        onError: (e) => setNotice({ tone: "danger", text: "The preset was not applied.", sub: problemOf(e).detail }),
      },
    );

  return (
    <>
      {notice && (
        <Toast
          tone={notice.tone}
          text={notice.text}
          sub={notice.sub}
          action={
            notice.reload ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
                Reload
              </button>
            ) : undefined
          }
          onDismiss={() => setNotice(null)}
        />
      )}

      <section className="card glass stack">
        <SectionHead title="Rules">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => open({ id: null })}>
            <Plus className="icon" aria-hidden="true" />
            New rule
          </button>
        </SectionHead>
        <p className="lede small">
          What happens on its own when something arrives or changes. Highest priority first; a rule can stop the ones
          after it.
        </p>
        {rules.isPending && <div className="skeleton sk-line" />}
        {rules.isError && (
          <ErrorState
            title="Could not load the rules"
            text={problemOf(rules.error).detail}
            onRetry={() => void rules.refetch()}
          />
        )}
        {editing && editing.id === null && (
          <RuleEditor
            initial={undefined}
            currency={currency}
            pending={write.isPending}
            error={problem}
            onSave={(body) =>
              write.mutate(
                { body },
                {
                  onSuccess: () => {
                    setEditing(null);
                    setNotice({ tone: "success", text: "Rule added." });
                  },
                },
              )
            }
            onClose={() => setEditing(null)}
          />
        )}
        {rules.isSuccess && items.length === 0 && !editing && (
          <div className="state">
            <h3>No rules yet</h3>
            <p>Start from a preset below, or write your own. Until then every item waits for you.</p>
          </div>
        )}
        <div className="stack">
          {items.map((rule) => (
            <RuleLine
              key={rule.id}
              rule={rule}
              currency={currency}
              editing={editing?.id === rule.id}
              confirming={confirmDelete === rule.id}
              pending={write.isPending}
              error={editing?.id === rule.id ? problem : null}
              onToggle={(enabled) =>
                write.mutate(
                  { id: rule.id, body: { enabled, expected_version: rule.version } },
                  { onError: (e) => failed(e, `“${rule.name}”`) },
                )
              }
              onEdit={() => open({ id: rule.id })}
              onClose={() => setEditing(null)}
              onSave={(body) =>
                write.mutate(
                  { id: rule.id, body },
                  {
                    onSuccess: () => {
                      setEditing(null);
                      setNotice({ tone: "success", text: "Rule saved." });
                    },
                    onError: (e) => {
                      if (problemOf(e).code === "version_conflict") failed(e, `“${rule.name}”`);
                    },
                  },
                )
              }
              onAskDelete={() => {
                write.reset();
                setConfirmDelete(rule.id);
              }}
              onDelete={() =>
                write.mutate(
                  { id: rule.id, remove: true },
                  {
                    onSuccess: () => {
                      setConfirmDelete(null);
                      setNotice({ tone: "success", text: `“${rule.name}” deleted.` });
                    },
                    onError: (e) => failed(e, `“${rule.name}”`),
                  },
                )
              }
              onKeep={() => setConfirmDelete(null)}
            />
          ))}
        </div>
      </section>

      <section className="card glass stack">
        <SectionHead title="Presets" />
        <p className="lede small">
          A starting point per kind of business. Each adds its rules; you can edit or switch them off afterwards.
        </p>
        {presets.isPending && <div className="skeleton sk-line" />}
        {presets.isError && (
          <ErrorState
            title="Could not load the presets"
            text={problemOf(presets.error).detail}
            onRetry={() => void presets.refetch()}
          />
        )}
        <div className="preset-cards">
          {(presets.data?.items ?? []).map((p) => (
            <div className="preset-card row-glass" key={p.key}>
              <h4>{p.name}</h4>
              <ul>
                {p.rules.map((r) => (
                  <li key={r.name}>{r.summary}</li>
                ))}
              </ul>
              {confirmPreset === p.key ? (
                <div className="stack">
                  <p className="hint">
                    You already have {items.length} rules. Add these alongside, or replace all rules with these?
                  </p>
                  <div className="rowx">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => applyPreset(p.key, false)}
                      disabled={apply.isPending}
                    >
                      Add alongside
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => applyPreset(p.key, true)}
                      disabled={apply.isPending}
                    >
                      Replace all rules
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmPreset(null)}
                      disabled={apply.isPending}
                    >
                      Keep as is
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rowx">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={apply.isPending}
                    onClick={() => (items.length > 0 ? setConfirmPreset(p.key) : applyPreset(p.key, false))}
                  >
                    {apply.isPending && apply.variables?.key === p.key && (
                      <span className="spinner" aria-hidden="true" />
                    )}
                    Add these {p.rules.length} rules
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function RuleLine({
  rule,
  currency,
  editing,
  confirming,
  pending,
  error,
  onToggle,
  onEdit,
  onClose,
  onSave,
  onAskDelete,
  onDelete,
  onKeep,
}: {
  rule: RuleView;
  currency: string;
  editing: boolean;
  confirming: boolean;
  pending: boolean;
  error: ReturnType<typeof problemOf> | null;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onClose: () => void;
  onSave: Parameters<typeof RuleEditor>[0]["onSave"];
  onAskDelete: () => void;
  onDelete: () => void;
  onKeep: () => void;
}) {
  return (
    <div className={clsx("rule-line row-glass", !rule.enabled && "is-off")}>
      <Switch checked={rule.enabled} onChange={onToggle} disabled={pending}>
        <span className="sr-only">{rule.enabled ? "On" : "Off"}</span>
      </Switch>
      <div>
        <div className="rule-summary">{rule.summary}</div>
        <div className="rule-meta">
          {rule.name} · priority {rule.priority}
          {!rule.enabled && " · off"}
        </div>
      </div>
      <div className="rowx">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-expanded={editing}>
          Edit
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onAskDelete} aria-expanded={confirming}>
          Delete
        </button>
      </div>
      {editing && (
        <div className="wide">
          <RuleEditor
            initial={rule}
            currency={currency}
            pending={pending}
            error={error}
            onSave={onSave}
            onClose={onClose}
          />
        </div>
      )}
      {confirming && (
        <div className="confirm row-glass wide">
          <h3>Delete “{rule.name}”</h3>
          <p className="hint">It stops running at once; what it already did stays in the timelines.</p>
          <div className="rowx">
            <button type="button" className="btn btn-danger" onClick={onDelete} disabled={pending}>
              Delete rule
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
