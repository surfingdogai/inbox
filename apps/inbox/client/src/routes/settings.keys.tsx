import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { Check, Copy, Plus } from "lucide-react";
import { useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { Field, SectionHead, Switch } from "../components/Form";
import { type ApiProblem, problemOf } from "../lib/api";
import { relativeTime } from "../lib/format";
import { qk, useCreateKey, useKeys, useRevokeKey, useSaveSettings, useSettings } from "../lib/queries";
import type { CreatedKey, CreateKeyBody, KeyList, KeyView, RefusalView } from "../lib/types";

export const Route = createFileRoute("/settings/keys")({
  component: KeysPage,
});

interface Notice {
  readonly tone: "success" | "danger";
  readonly text: string;
}

/**
 * Settings → Keys: one named, scoped key per system that calls this inbox — Zapier, a shop, a
 * till, a form plugin — each revocable in one click, and what each one called outside its scopes.
 * The two switches here are the owner's alone: whether their AI may make keys, and whether a call
 * outside a key's scopes is refused or only written down.
 */
function KeysPage() {
  const keys = useKeys();
  return (
    <>
      <SecurityCard list={keys.data} />
      <KeysCard />
      {keys.data && keys.data.ai_clients.length > 0 && <AiAppsCard list={keys.data} />}
    </>
  );
}

/* --- The two switches ------------------------------------------------------ */

function SecurityCard({ list }: { list: KeyList | undefined }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const security = settings.data?.doc.security ?? {
    aiMayCreateKeys: list?.security.ai_may_create_keys ?? false,
    enforceScopes: list?.security.enforce_scopes ?? false,
  };
  const change = (patch: Record<string, boolean>, done: string) => {
    if (!settings.data || save.isPending) return;
    save.reset();
    setNotice(null);
    save.mutate(
      { doc: { security: patch }, expected_version: settings.data.version },
      {
        onSuccess: () => {
          setNotice({ tone: "success", text: done });
          void qc.invalidateQueries({ queryKey: qk.keys });
        },
        onError: (e) => setNotice({ tone: "danger", text: problemOf(e).detail }),
      },
    );
  };
  return (
    <section className="card glass stack">
      <SectionHead title="What your AI may do with keys" />
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      <Switch
        checked={security.aiMayCreateKeys}
        disabled={!settings.data || save.isPending}
        onChange={(on) =>
          change(
            { aiMayCreateKeys: on },
            on
              ? "Your AI can now create and revoke integration keys. Each one appears here."
              : "Your AI can no longer create or revoke keys.",
          )
        }
      >
        Let my AI create keys
      </Switch>
      <p className="hint">
        When your AI connects your shop, till or Zapier, it can make the key that system needs instead of asking you to.
        Every key it makes is named, limited to the scopes it chose, listed below, and revocable in one click. It can
        never make a key that changes settings, and it cannot revoke the keys you made.
      </p>
      <Switch
        checked={security.enforceScopes}
        disabled={!settings.data || save.isPending}
        onChange={(on) =>
          change(
            { enforceScopes: on },
            on
              ? "Calls outside a key's scopes are now refused."
              : "Calls outside a key's scopes go through again and are only recorded.",
          )
        }
      >
        Refuse calls outside a key's scopes
      </Switch>
      <p className="hint">
        Off, such a call still goes through and is recorded under its key below, so you can see what would break before
        anything does. A later release turns this on for everyone.
      </p>
    </section>
  );
}

/* --- Keys ------------------------------------------------------------------ */

function KeysCard() {
  const keys = useKeys();
  const create = useCreateKey();
  const revoke = useRevokeKey();
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const rows = keys.data?.items ?? [];

  return (
    <section className="card glass stack">
      <SectionHead title="Keys">
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
          New key
        </button>
      </SectionHead>
      <p className="lede small">
        One key per system that calls this inbox, named after it, with only the scopes it needs. Paste it where the
        system asks for an API key or a Bearer token. If one leaks, revoke it: the others keep working.
      </p>
      {notice && <Toast tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} />}
      {revealed && <KeyPanel created={revealed} onDone={() => setRevealed(null)} />}
      {keys.isPending && <div className="skeleton sk-line" />}
      {keys.isError && (
        <ErrorState
          title="Could not load the keys"
          text={problemOf(keys.error).detail}
          onRetry={() => void keys.refetch()}
        />
      )}
      {keys.isSuccess && rows.length === 0 && !adding && (
        <div className="state">
          <h3>No keys yet</h3>
          <p>Create one for the first system you connect, or let your AI create it for you.</p>
        </div>
      )}
      {adding && keys.data && (
        <KeyForm
          list={keys.data}
          pending={create.isPending}
          error={create.error ? problemOf(create.error) : null}
          onCancel={() => setAdding(false)}
          onSubmit={(body) =>
            create.mutate(body, {
              onSuccess: (key) => {
                setAdding(false);
                setRevealed(key);
              },
            })
          }
        />
      )}
      <div className="stack">
        {rows.map((key) => (
          <KeyLine
            key={key.id}
            keyView={key}
            pending={revoke.isPending}
            error={acting === key.id && revoke.error ? problemOf(revoke.error) : null}
            onRevoke={() => {
              revoke.reset();
              setNotice(null);
              setActing(key.id);
              revoke.mutate(key.id, {
                onSuccess: () => {
                  setActing(null);
                  setRevealed((current) => (current?.id === key.id ? null : current));
                  setNotice({ tone: "success", text: `“${key.name}” revoked. Whatever used it can no longer get in.` });
                },
              });
            }}
          />
        ))}
      </div>
    </section>
  );
}

/** The key, shown once. There is no second chance to read it, so the panel says so plainly. */
function KeyPanel({ created, onDone }: { created: CreatedKey; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!created.key) {
    return (
      <div className="confirm row-glass">
        <h3>That key was already created</h3>
        <p className="hint">{created.key_note}</p>
        <div className="rowx">
          <button type="button" className="btn btn-primary" onClick={onDone}>
            Close
          </button>
        </div>
      </div>
    );
  }
  const key = created.key;
  return (
    <div className="confirm row-glass">
      <h3>Store “{created.name}” now</h3>
      <p className="hint">
        This is the only time the key is shown. It cannot be read back; if it is lost, revoke it and create another.
      </p>
      <div className="rowx">
        <code className="mono secret">{key}</code>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(key)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <Check className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="rowx">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I have stored it
        </button>
      </div>
    </div>
  );
}

function KeyLine({
  keyView: k,
  pending,
  error,
  onRevoke,
}: {
  keyView: KeyView;
  pending: boolean;
  error: ApiProblem | null;
  onRevoke: () => void;
}) {
  const outside = k.refusals.reduce((n, r) => n + r.count, 0);
  const meta = [
    k.kind === "owner" ? "full owner key" : k.scopes.join(" · "),
    k.last_used_at ? `used ${relativeTime(k.last_used_at)}` : "never used",
    k.created_by?.startsWith("owner_ai:") ? `made by your AI ${k.created_by.slice("owner_ai:".length)}` : null,
    k.expires_at ? `expires ${new Date(k.expires_at).toLocaleDateString()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={clsx("catalogue-row row-glass", !k.active && "is-archived")}>
      <div className="catalogue-main">
        <div className="t">
          <b>{k.name}</b>
          {!k.active && <span className="pill pill-xs">{k.revoked_at ? "Revoked" : "Expired"}</span>}
          {k.active && outside > 0 && <span className="pill pill-xs">Outside its scopes</span>}
        </div>
        <div className="s">{meta}</div>
        <div className="s mono">{k.hint}</div>
        {k.refusals.length > 0 && <Refusals refusals={k.refusals} />}
        {error && (
          <div className="hint error" role="alert">
            {error.detail}
          </div>
        )}
      </div>
      {k.active && (
        <div className="rowx">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRevoke} disabled={pending}>
            Revoke
          </button>
        </div>
      )}
    </div>
  );
}

function Refusals({ refusals }: { refusals: readonly RefusalView[] }) {
  return (
    <ul className="hint">
      {refusals.map((r) => (
        <li key={r.operation}>
          {r.enforced ? "Refused" : "Would be refused"}: {r.operation} needs {r.scope} ({r.count}×, last{" "}
          {relativeTime(r.last_at)})
        </li>
      ))}
    </ul>
  );
}

function KeyForm({
  list,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  list: KeyList;
  pending: boolean;
  error: ApiProblem | null;
  onSubmit: (body: CreateKeyBody) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<string>(list.presets[0]?.key ?? "");
  const [scopes, setScopes] = useState<string[]>([...(list.presets[0]?.scopes ?? [])]);
  const choosable = list.scopes.filter((s) => s.scope !== "keys:write" && s.scope !== "offline_access");
  return (
    <form
      className="confirm row-glass stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name: name.trim(), scopes });
      }}
    >
      <Field
        id="key-name"
        label="Name"
        hint="The system it goes into, so you know which key to revoke: Zapier, Shop sync, Front desk till."
        error={error?.field("name")}
      >
        <input
          id="key-name"
          className="input"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Zapier"
          required
        />
      </Field>
      <div>
        <span className="label">For</span>
        <div className="stack sub">
          {list.presets.map((p) => (
            <label key={p.key} className="check">
              <input
                type="radio"
                name="key-preset"
                checked={preset === p.key}
                disabled={pending}
                onChange={() => {
                  setPreset(p.key);
                  setScopes([...p.scopes]);
                }}
              />
              <span>
                <b>{p.name}</b> — {p.description}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <span className="label">Scopes</span>
        <div className="stack sub">
          {choosable.map((s) => (
            <Switch
              key={s.scope}
              checked={scopes.includes(s.scope)}
              disabled={pending}
              onChange={(on) => {
                setPreset("");
                setScopes((prev) => (on ? [...prev, s.scope] : prev.filter((x) => x !== s.scope)));
              }}
            >
              {s.label} <span className="mono">({s.scope})</span>
            </Switch>
          ))}
        </div>
        {error?.field("scopes") && (
          <div className="hint error" role="alert">
            {error.field("scopes")}
          </div>
        )}
      </div>
      {error && !error.field("name") && !error.field("scopes") && (
        <p className="hint error" role="alert">
          {error.detail}
        </p>
      )}
      <div className="rowx">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || name.trim() === "" || scopes.length === 0}
        >
          {pending ? "Creating…" : "Create key"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* --- AI apps --------------------------------------------------------------- */

function AiAppsCard({ list }: { list: KeyList }) {
  return (
    <section className="card glass stack">
      <SectionHead title="AI apps outside their scopes" />
      <p className="hint">
        These apps connected with a sign-in and called something you did not grant them. Nothing was refused unless the
        switch above is on. To grant more, connect the app again and allow the scopes it asks for.
      </p>
      <div className="stack">
        {list.ai_clients.map((a) => (
          <div key={a.id} className="catalogue-row row-glass">
            <div className="catalogue-main">
              <div className="t">
                <b>{a.name ?? a.id}</b>
              </div>
              <Refusals refusals={a.refusals} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
