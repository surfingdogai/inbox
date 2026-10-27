import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, problemOf } from "../lib/api";
import { qk, useSpamModel } from "../lib/queries";
import { defaultModel, GEMINI_NOTE, MODEL_HINT, MODEL_INTRO, ONLY_YOU, testFailed, testLine } from "../lib/spam";
import type { ModelCard as Card, ModelChoice, ModelTest } from "../lib/types";
import { SectionHead } from "./Form";

type Provider = Card["providers"][number]["id"];

/**
 * Settings → Integrations → Your AI model (ADR-041 §11.5), on one's own server: a provider chosen,
 * the key pasted once (it goes to the inbox, sealed, and is never shown again), a model from that
 * provider's own list, and Test with two samples. Set up by the server instead, it says so and
 * offers nothing to change. A hosted inbox shows no card: its host reads for it.
 */
export function ModelCard() {
  const card = useSpamModel();
  const qc = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [test, setTest] = useState<ModelTest | null>(null);
  const done = (data: Card) => {
    qc.setQueryData(qk.spamModel, data);
    void qc.invalidateQueries({ queryKey: qk.spam });
  };
  const remove = useMutation({ mutationFn: api.removeSpamModel, onSuccess: done });
  const run = useMutation({
    mutationFn: api.testSpamModel,
    onSuccess: (r) => {
      setTest(r);
      void qc.invalidateQueries({ queryKey: qk.spamModel });
    },
  });
  const c = card.data;
  if (!c || c.not_offered === "hosted") return null;

  return (
    <section className="card glass stack" aria-labelledby="model-h">
      <SectionHead title="Your AI model" />
      <p className="lede small" id="model-h">
        {MODEL_INTRO}
      </p>
      {c.set_by_server ? (
        <p className="hint">
          Set by your server: {c.set_by_server.model} ({c.set_by_server.provider}). Nothing to change here.
        </p>
      ) : c.not_offered === "no_secret" ? (
        <p className="hint">This server can't keep a key yet: set INBOX_SECRET_KEY, then add your model here.</p>
      ) : c.own && !changing ? (
        <div className="stack">
          <p>
            <b>{c.own.model}</b> <span className="lede small">from {c.own.provider_name}</span>
          </p>
          {test ? (
            <p className="fine" role="status">
              {test.ok ? testLine(test) : testFailed(test.why)}
            </p>
          ) : (
            c.own.tested && <p className="fine">{testLine(c.own.tested)}</p>
          )}
          {run.error && <p className="hint">{problemOf(run.error).detail}</p>}
          {remove.error && <p className="hint">{problemOf(remove.error).detail}</p>}
          {c.can_change ? (
            <div className="rowx">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={run.isPending}
                onClick={() => {
                  setTest(null);
                  run.mutate();
                }}
              >
                {run.isPending && <span className="spinner" aria-hidden="true" />}
                Test
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChanging(true)}>
                Change
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove
              </button>
            </div>
          ) : (
            <p className="hint">{ONLY_YOU}</p>
          )}
        </div>
      ) : c.can_change ? (
        <ModelSteps
          card={c}
          onCancel={c.own ? () => setChanging(false) : undefined}
          onSaved={(data) => {
            done(data);
            setChanging(false);
            setTest(null);
          }}
        />
      ) : (
        <p className="hint">No model is connected. {ONLY_YOU}</p>
      )}
    </section>
  );
}

function ModelSteps({
  card,
  onSaved,
  onCancel,
}: {
  card: Card;
  onSaved: (card: Card) => void;
  onCancel?: (() => void) | undefined;
}) {
  const id = useId();
  const [provider, setProvider] = useState<Provider>(card.own?.provider ?? "anthropic");
  const [key, setKey] = useState("");
  const [models, setModels] = useState<readonly ModelChoice[] | null>(null);
  const [model, setModel] = useState("");
  const keptKey = card.own?.provider === provider;
  const list = useMutation({
    mutationFn: () => api.spamModels(provider, key.trim() || undefined),
    onSuccess: (r) => {
      setModels(r.models);
      // A small model if the provider has one; else nothing until the owner chooses.
      setModel(defaultModel(r.models));
    },
  });
  const save = useMutation({
    mutationFn: () => api.setSpamModel({ provider, model, ...(key.trim() ? { key: key.trim() } : {}) }),
    onSuccess: (data) => {
      setKey("");
      onSaved(data);
    },
  });
  const choose = (p: Provider) => {
    setProvider(p);
    setModels(null);
    setModel("");
    list.reset();
  };
  const problem = list.error ? problemOf(list.error) : save.error ? problemOf(save.error) : null;
  return (
    <div className="model-steps">
      <fieldset className="seg seg-wrap" aria-label="Provider">
        {card.providers.map((p) => (
          <button key={p.id} type="button" aria-pressed={provider === p.id} onClick={() => choose(p.id)}>
            {p.name}
          </button>
        ))}
      </fieldset>
      {provider === "gemini" && <p className="fine">{GEMINI_NOTE}</p>}
      <div>
        <label className="label" htmlFor={`${id}-key`}>
          Paste the key from your account
        </label>
        <input
          id={`${id}-key`}
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={keptKey ? "Kept: leave empty to keep it" : ""}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setModels(null);
          }}
        />
      </div>
      {models === null ? (
        <div className="rowx">
          {onCancel && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={list.isPending || (!key.trim() && !keptKey)}
            onClick={() => list.mutate()}
          >
            {list.isPending && <span className="spinner" aria-hidden="true" />}
            Show the models
          </button>
        </div>
      ) : models.length === 0 ? (
        <p className="hint">This key lists no models that read text. Try another key.</p>
      ) : (
        <>
          <div>
            <label className="label" htmlFor={`${id}-model`}>
              Model
            </label>
            <select id={`${id}-model`} className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {!model && (
                <option value="" disabled>
                  Choose a model
                </option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <div className="hint">{MODEL_HINT}</div>
          </div>
          <div className="rowx">
            {onCancel && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!model || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending && <span className="spinner" aria-hidden="true" />}
              Save
            </button>
          </div>
        </>
      )}
      {problem && (
        <p className="hint" role="alert">
          {problem.detail}
        </p>
      )}
    </div>
  );
}
