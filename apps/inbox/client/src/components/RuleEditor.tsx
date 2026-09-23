import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { type ApiProblem, api, problemOf } from "../lib/api";
import { summarizeRule } from "../lib/describe";
import { stateWord, TYPE_WORD, titleFor } from "../lib/format";
import {
  type ActionRow,
  type Built,
  type ConditionRow,
  EMPTY_ACTION,
  EMPTY_CONDITION,
  EMPTY_RULE,
  FN_WORDS,
  FNS,
  type Fn,
  isMoneyPath,
  OP_WORDS,
  OPS,
  type Op,
  PATHS,
  parsePriority,
  type RuleForm,
  TRIGGER_EVENTS,
  toDefinition,
  toForm,
} from "../lib/rules";
import type { RuleBody, RuleDefinition, RuleView } from "../lib/types";
import { Field, Switch } from "./Form";

/**
 * A rule as forms: when it runs, what must be true, what it does. The sentence the engine will
 * live by is read back as it is written; "Try it" evaluates the conditions against a real item
 * on the server without changing anything. JSON is one toggle away for anything the forms
 * cannot say.
 */
export function RuleEditor({
  initial,
  currency,
  pending,
  error,
  onSave,
  onClose,
}: {
  initial: RuleView | undefined;
  currency: string;
  pending: boolean;
  error: ApiProblem | null;
  onSave: (body: RuleBody) => void;
  onClose: () => void;
}) {
  const start = initial
    ? toForm(initial.definition, { name: initial.name, priority: initial.priority, enabled: initial.enabled })
    : { form: EMPTY_RULE, simple: true };
  const [form, setForm] = useState<RuleForm>(start.form);
  const [json, setJson] = useState<string | null>(start.simple ? null : JSON.stringify(initial?.definition, null, 2));
  const [jsonNote, setJsonNote] = useState<string | null>(
    start.simple ? null : "This rule has nested conditions the form cannot show, so it is edited as JSON.",
  );
  const [keys, setKeys] = useState(() => ({
    conds: start.form.conditions.map((_c, i) => i + 1),
    actions: start.form.actions.map((_a, i) => i + 1),
    next: start.form.conditions.length + start.form.actions.length + 1,
  }));
  const [local, setLocal] = useState<string | null>(null);
  const [testItem, setTestItem] = useState("");

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const built: Built = json !== null ? parseJson(json) : toDefinition(form);
  const summary = built.ok ? summarizeRule(built.definition) : null;

  const recent = useQuery({
    queryKey: ["items", "recent-for-rules"],
    queryFn: () => api.listItems({ open_only: false, limit: 50 }),
    staleTime: 60_000,
  });
  const test = useMutation({
    mutationFn: (input: { definition: RuleDefinition; itemId: string }) =>
      api.testRule(input.definition, input.itemId, form.name),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!form.name.trim()) return setLocal("Give the rule a name; it appears in timelines as the reason.");
    const priority = parsePriority(form.priority);
    if (priority === null) return setLocal("Priority is a whole number between -1000 and 1000; higher runs first.");
    if (!built.ok) return setLocal(built.problem);
    setLocal(null);
    onSave({
      name: form.name.trim(),
      priority,
      enabled: form.enabled,
      definition: built.definition,
      ...(initial ? { expected_version: initial.version } : {}),
    });
  };

  const showJson = () => {
    if (!built.ok) return setLocal(built.problem);
    setLocal(null);
    setJson(JSON.stringify(built.definition, null, 2));
    setJsonNote(null);
  };
  const backToForm = () => {
    if (json === null) return;
    const parsed = parseJson(json);
    if (!parsed.ok) return setLocal(parsed.problem);
    const next = toForm(parsed.definition, {
      name: form.name,
      priority: form.priority ? Number(form.priority) : 0,
      enabled: form.enabled,
    });
    if (!next.simple) {
      setJsonNote("This rule has nested conditions the form cannot show; keep editing it as JSON.");
      return;
    }
    setLocal(null);
    setJsonNote(null);
    setForm({ ...next.form, name: form.name, priority: form.priority, enabled: form.enabled });
    setKeys({
      conds: next.form.conditions.map((_c, i) => i + 1),
      actions: next.form.actions.map((_a, i) => i + 1),
      next: next.form.conditions.length + next.form.actions.length + 1,
    });
    setJson(null);
  };

  const updateCond = (i: number, patch: Partial<ConditionRow>) =>
    set(
      "conditions",
      form.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    );
  const removeCond = (i: number) => {
    set(
      "conditions",
      form.conditions.filter((_c, j) => j !== i),
    );
    setKeys((k) => ({ ...k, conds: k.conds.filter((_x, j) => j !== i) }));
  };
  const addCond = (kind: ConditionRow["kind"]) => {
    set("conditions", [...form.conditions, { ...EMPTY_CONDITION, kind }]);
    setKeys((k) => ({ ...k, conds: [...k.conds, k.next], next: k.next + 1 }));
  };
  const updateAction = (i: number, patch: Partial<ActionRow>) =>
    set(
      "actions",
      form.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    );
  const removeAction = (i: number) => {
    set(
      "actions",
      form.actions.filter((_a, j) => j !== i),
    );
    setKeys((k) => ({ ...k, actions: k.actions.filter((_x, j) => j !== i) }));
  };
  const addAction = () => {
    set("actions", [...form.actions, { ...EMPTY_ACTION }]);
    setKeys((k) => ({ ...k, actions: [...k.actions, k.next], next: k.next + 1 }));
  };

  const fieldError = (path: string) => error?.field(path);
  const definitionErrors = (error?.fields ?? []).filter((f) => f.path.startsWith("definition"));

  return (
    <form className="confirm row-glass rule-editor" onSubmit={submit}>
      <h3>{initial ? `Edit “${initial.name}”` : "New rule"}</h3>
      <div className="settings-grid">
        <Field
          id="r-name"
          label="Name"
          error={fieldError("name")}
          hint="Shown in timelines as the reason for what the rule did."
        >
          <input id="r-name" className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field id="r-priority" label="Priority" error={fieldError("priority")} hint="Higher runs first.">
          <input
            id="r-priority"
            className="input"
            type="number"
            min={-1000}
            max={1000}
            value={form.priority}
            onChange={(e) => set("priority", e.target.value)}
          />
        </Field>
        <div className="wide">
          <Switch checked={form.enabled} onChange={(v) => set("enabled", v)}>
            On
          </Switch>
        </div>
      </div>

      {json === null ? (
        <>
          <div className="stack">
            <div className="eyebrow">When</div>
            <div className="rowx">
              <label className="check">
                <input type="checkbox" checked={form.onCreated} onChange={(e) => set("onCreated", e.target.checked)} />A
                new item arrives
              </label>
              <label className="check">
                <input type="checkbox" checked={form.onInbound} onChange={(e) => set("onInbound", e.target.checked)} />A
                message arrives on an item
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.onTransitioned}
                  onChange={(e) => set("onTransitioned", e.target.checked)}
                />
                An item changes state
              </label>
            </div>
            <div className="rowx">
              <label className="label" htmlFor="r-event" style={{ margin: 0 }}>
                …or when an item is
              </label>
              <select
                id="r-event"
                className="input scope-select"
                value=""
                onChange={(e) => {
                  if (e.target.value && !form.onEvents.includes(e.target.value))
                    set("onEvents", [...form.onEvents, e.target.value]);
                }}
              >
                <option value="">Add an event…</option>
                {TRIGGER_EVENTS.map((ev) => (
                  <option key={ev} value={ev}>
                    {ev.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <div className="event-pills">
                {form.onEvents.map((ev) => (
                  <span className="pill" key={ev}>
                    {ev.replaceAll("_", " ")}
                    <button
                      type="button"
                      aria-label={`Remove ${ev}`}
                      onClick={() =>
                        set(
                          "onEvents",
                          form.onEvents.filter((x) => x !== ev),
                        )
                      }
                    >
                      <X className="icon-xs" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="rowx">
              <span className="eyebrow" style={{ margin: 0 }}>
                If
              </span>
              {form.conditions.length > 1 && (
                <select
                  className="input scope-select"
                  aria-label="How the conditions combine"
                  value={form.match}
                  onChange={(e) => set("match", e.target.value === "any" ? "any" : "all")}
                >
                  <option value="all">all of these hold</option>
                  <option value="any">any of these holds</option>
                </select>
              )}
            </div>
            {form.conditions.length === 0 && <p className="hint">No conditions: the rule runs every time.</p>}
            {form.conditions.map((c, i) => (
              <ConditionEditor
                key={keys.conds[i] ?? i}
                row={c}
                currency={currency}
                onChange={(patch) => updateCond(i, patch)}
                onRemove={() => removeCond(i)}
              />
            ))}
            <div className="rowx">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => addCond("field")}>
                <Plus className="icon" aria-hidden="true" />
                Add a check
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => addCond("fact")}>
                <Plus className="icon" aria-hidden="true" />
                Add a fact
              </button>
            </div>
          </div>

          <div className="stack">
            <div className="eyebrow">Then</div>
            {form.actions.map((a, i) => (
              <ActionEditor
                key={keys.actions[i] ?? i}
                row={a}
                onChange={(patch) => updateAction(i, patch)}
                onRemove={() => removeAction(i)}
              />
            ))}
            <div className="rowx">
              <button type="button" className="btn btn-secondary btn-sm" onClick={addAction}>
                <Plus className="icon" aria-hidden="true" />
                Add an action
              </button>
            </div>
          </div>

          <div className="settings-grid">
            <div>
              <Switch checked={form.stop} onChange={(v) => set("stop", v)}>
                Stop other rules after this one
              </Switch>
            </div>
            <Field id="r-max" label="Runs per item, at most" hint="So a rule cannot loop on one item.">
              <input
                id="r-max"
                className="input"
                type="number"
                min={1}
                max={50}
                value={form.maxRuns}
                onChange={(e) => set("maxRuns", e.target.value)}
              />
            </Field>
          </div>
        </>
      ) : (
        <div className="stack">
          {jsonNote && <p className="hint">{jsonNote}</p>}
          <Field
            id="r-json"
            label="Definition (JSON)"
            hint="on, if, actions, stop, maxRunsPerItem; the server checks it on save."
          >
            <textarea
              id="r-json"
              className="input json-editor"
              spellCheck={false}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
          </Field>
        </div>
      )}

      <div className={clsx("reads-as row-glass", !built.ok && "error")} aria-live="polite">
        {summary ? (
          <>
            <strong>Reads as:</strong> {summary}
          </>
        ) : (
          <span className="hint error">{built.ok ? "" : built.problem}</span>
        )}
      </div>

      <div className="stack">
        <div className="eyebrow">Try it</div>
        <div className="rowx">
          <select
            className="input scope-select"
            aria-label="An item to try the rule on"
            value={testItem}
            onChange={(e) => setTestItem(e.target.value)}
          >
            <option value="">Pick an item from the inbox…</option>
            {(recent.data?.items ?? []).map((v) => (
              <option key={v.item.id} value={v.item.id}>
                {TYPE_WORD[v.item.type]} · {titleFor(v.item)} · {stateWord(v.item.state).toLowerCase()}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!testItem || !built.ok || test.isPending}
            onClick={() => {
              if (built.ok && testItem) test.mutate({ definition: built.definition, itemId: testItem });
            }}
          >
            {test.isPending && <span className="spinner" aria-hidden="true" />}
            Try it
          </button>
        </div>
        {test.data && (
          <p className={clsx("hint", test.data.matched ? "success" : undefined)} aria-live="polite">
            {test.data.matched
              ? `Would fire on this ${test.data.item.type.replaceAll("_", " ")}: ${test.data.would.join(", then ")}.`
              : `Would not fire on this ${test.data.item.type.replaceAll("_", " ")}.`}{" "}
            {test.data.item.type === "booking" &&
              `Slot free: ${yesNo(test.data.facts.slotIsFree)} · inside opening hours: ${yesNo(test.data.facts.withinBusinessHours)}.`}
          </p>
        )}
        {test.data?.skipped?.map((line) => (
          <p key={line} className="hint">
            {line}.
          </p>
        ))}
        {test.error && (
          <p className="hint error" role="alert">
            {problemOf(test.error).detail}
          </p>
        )}
      </div>

      {(local || (error && !error.fields?.length) || definitionErrors.length > 0) && (
        <div className="hint error" role="alert">
          {local ?? error?.detail}
          {definitionErrors.map((f) => (
            <div key={f.path}>
              {f.path}: {f.message}
            </div>
          ))}
        </div>
      )}

      <div className="rowx">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {initial ? "Save rule" : "Add rule"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={pending}>
          Keep as is
        </button>
        <span className="sp" />
        {json === null ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={showJson}>
            Show JSON
          </button>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={backToForm}>
            Back to the form
          </button>
        )}
      </div>
    </form>
  );
}

const yesNo = (v: boolean | null) => (v === null ? "n/a" : v ? "yes" : "no");

function parseJson(text: string): Built {
  try {
    const def = JSON.parse(text) as Partial<RuleDefinition>;
    if (!def || typeof def !== "object" || !Array.isArray(def.on) || !def.if || !Array.isArray(def.actions)) {
      return { ok: false, problem: "The JSON needs on (a list), if (a condition) and actions (a list)." };
    }
    return {
      ok: true,
      definition: {
        on: def.on,
        if: def.if,
        actions: def.actions,
        stop: def.stop ?? false,
        maxRunsPerItem: def.maxRunsPerItem ?? 5,
      },
    };
  } catch {
    return { ok: false, problem: "That is not valid JSON yet." };
  }
}

const VALUE_HINTS: Record<string, string> = {
  "item.type": "booking, order, quote_request, message or refund",
  "item.state": "like requested, confirmed, open, received",
  "party.kind": "customer_human or customer_agent",
  "party.tier": "anonymous, signed_agent, verified_principal, reputed_principal",
  "event.actorKind": "customer_human, customer_agent, owner, staff, rule, system",
};

function ConditionEditor({
  row,
  currency,
  onChange,
  onRemove,
}: {
  row: ConditionRow;
  currency: string;
  onChange: (patch: Partial<ConditionRow>) => void;
  onRemove: () => void;
}) {
  const known = PATHS.some((p) => p.path === row.path);
  const [custom, setCustom] = useState(!known && row.path !== "");
  const needsValue = row.op !== "exists" && row.op !== "empty";
  return (
    <div className="cond-row">
      <label className="check" title="Negate this condition">
        <input type="checkbox" checked={row.not} onChange={(e) => onChange({ not: e.target.checked })} />
        not
      </label>
      {row.kind === "fact" ? (
        <div className="cond-fields">
          <select
            className="input"
            aria-label="Fact"
            value={row.fn}
            onChange={(e) => onChange({ fn: e.target.value as Fn })}
          >
            {FNS.map((fn) => (
              <option key={fn} value={fn}>
                {FN_WORDS[fn]}
              </option>
            ))}
          </select>
          {row.fn === "text_has_keywords" && (
            <input
              className="input"
              aria-label="Words, comma-separated"
              placeholder="urgent, leak, asap"
              value={row.keywords}
              onChange={(e) => onChange({ keywords: e.target.value })}
            />
          )}
        </div>
      ) : (
        <div className="cond-fields">
          <select
            className="input"
            aria-label="Field"
            value={custom ? "__custom" : row.path}
            onChange={(e) => {
              if (e.target.value === "__custom") {
                setCustom(true);
                onChange({ path: "" });
              } else {
                setCustom(false);
                onChange({ path: e.target.value });
              }
            }}
          >
            {PATHS.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label}
              </option>
            ))}
            <option value="__custom">something else…</option>
          </select>
          {custom && (
            <input
              className="input"
              aria-label="Path"
              placeholder="item.payload.partySize"
              value={row.path}
              onChange={(e) => onChange({ path: e.target.value })}
            />
          )}
          <select
            className="input"
            aria-label="Comparison"
            value={row.op}
            onChange={(e) => onChange({ op: e.target.value as Op })}
          >
            {OPS.map((op) => (
              <option key={op} value={op}>
                {OP_WORDS[op]}
              </option>
            ))}
          </select>
          {needsValue && (
            <input
              className="input"
              aria-label="Value"
              placeholder={
                isMoneyPath(row.path)
                  ? `in ${currency}, like 50`
                  : row.op === "in" || row.op === "nin" || row.op === "between"
                    ? "comma-separated"
                    : (VALUE_HINTS[row.path] ?? "value")
              }
              value={row.value}
              onChange={(e) => onChange({ value: e.target.value })}
            />
          )}
        </div>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-label="Remove this condition"
        onClick={onRemove}
      >
        <X className="icon" aria-hidden="true" />
      </button>
    </div>
  );
}

function ActionEditor({
  row,
  onChange,
  onRemove,
}: {
  row: ActionRow;
  onChange: (patch: Partial<ActionRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="action-row">
      <select
        className="input scope-select"
        aria-label="What to do"
        value={row.kind}
        onChange={(e) => onChange({ kind: e.target.value as ActionRow["kind"] })}
      >
        <option value="transition">Move it on</option>
        <option value="set_flags">Flag it</option>
        <option value="reply">Reply</option>
        <option value="enqueue">Schedule a job</option>
        <option value="stop">Stop other rules</option>
      </select>
      <div className="action-fields">
        {row.kind === "transition" && (
          <>
            <select
              className="input"
              aria-label="Event"
              value={TRIGGER_EVENTS.includes(row.event as (typeof TRIGGER_EVENTS)[number]) ? row.event : "__custom"}
              onChange={(e) => onChange({ event: e.target.value === "__custom" ? "" : e.target.value })}
            >
              {TRIGGER_EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev.replaceAll("_", " ")}
                </option>
              ))}
              <option value="__custom">another event…</option>
            </select>
            {!TRIGGER_EVENTS.includes(row.event as (typeof TRIGGER_EVENTS)[number]) && (
              <input
                className="input"
                aria-label="Event name"
                placeholder="event name"
                value={row.event}
                onChange={(e) => onChange({ event: e.target.value })}
              />
            )}
            <input
              className="input"
              aria-label="Reason"
              placeholder="Reason shown in the timeline, optional"
              value={row.reason}
              onChange={(e) => onChange({ reason: e.target.value })}
            />
          </>
        )}
        {row.kind === "set_flags" && (
          <>
            <select
              className="input"
              aria-label="Needs a person"
              value={row.needsHuman}
              onChange={(e) => onChange({ needsHuman: e.target.value as ActionRow["needsHuman"] })}
            >
              <option value="keep">leave the needs-you flag</option>
              <option value="flag">flag it for a person</option>
              <option value="clear">clear the needs-you flag</option>
            </select>
            <select
              className="input"
              aria-label="Priority"
              value={row.priority}
              onChange={(e) => onChange({ priority: e.target.value as ActionRow["priority"] })}
            >
              <option value="keep">leave the priority</option>
              <option value="0">priority 0, normal</option>
              <option value="1">priority 1</option>
              <option value="2">priority 2</option>
              <option value="3">priority 3, highest</option>
            </select>
          </>
        )}
        {row.kind === "reply" && (
          <>
            <textarea
              className="input wide"
              aria-label="Reply text"
              rows={2}
              placeholder="Thanks, we answer within a working day. {{item.subject}} works as a placeholder."
              value={row.template}
              onChange={(e) => onChange({ template: e.target.value })}
            />
            <div className="wide">
              <Switch checked={row.internal} onChange={(v) => onChange({ internal: v })}>
                As an internal note, not to the customer
              </Switch>
            </div>
          </>
        )}
        {row.kind === "enqueue" && (
          <>
            <input
              className="input"
              aria-label="Job"
              placeholder="job name"
              value={row.job}
              onChange={(e) => onChange({ job: e.target.value })}
            />
            <input
              className="input"
              aria-label="Delay in minutes"
              placeholder="delay, minutes"
              inputMode="numeric"
              value={row.delayMin}
              onChange={(e) => onChange({ delayMin: e.target.value })}
            />
            <input
              className="input"
              aria-label="Payload JSON"
              placeholder='{"kind": "reminder"}'
              value={row.payload}
              onChange={(e) => onChange({ payload: e.target.value })}
            />
          </>
        )}
        {row.kind === "stop" && <span className="hint">No later rule runs for this event.</span>}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-label="Remove this action"
        onClick={onRemove}
      >
        <X className="icon" aria-hidden="true" />
      </button>
    </div>
  );
}
