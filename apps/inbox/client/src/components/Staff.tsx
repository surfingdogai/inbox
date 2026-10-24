import { ArrowDown, ArrowUp, CalendarDays, ImagePlus, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { majorText, parseMajor } from "../lib/actions";
import { problemOf } from "../lib/api";
import { describePrice } from "../lib/catalogue";
import { minorUnitsOf } from "../lib/currencies";
import { checkDraft, toDraft } from "../lib/hours";
import { useIntegrations, useServices } from "../lib/queries";
import {
  initials,
  ownLengths,
  type StaffBody,
  type StaffServiceBody,
  type StaffView,
  shownName,
  smallPhoto,
  useStaff,
  useStaffWrite,
  useTieCalendar,
} from "../lib/staff";
import type { ServiceRow, Weekly } from "../lib/types";
import { DurationPicker, MoneyInput } from "./Choosers";
import { ErrorState, Toast } from "./Feedback";
import { Field, FormActions, SectionHead, Switch } from "./Form";
import { HoursEditor } from "./Hours";
import "./staff.css";

/**
 * Settings → Staff (ADR-035): who works here, in the owner's order (moved up and down, as services are:
 * a booking for anyone goes to the first free). Each person: the name the owner knows them by, the first
 * name customers see, a photo, the services they give (one press each) with their own price and length
 * for any, their own hours, and their own calendar. Prices are the owner's; customers only ever see a
 * first name and a photo.
 */
export function StaffCard({ currency }: { currency: string }) {
  const staff = useStaff();
  const services = useServices();
  const write = useStaffWrite();
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = staff.data?.items ?? [];
  const offered = (services.data?.items ?? []).filter((s) => s.active === 1);
  const done = (text: string) => {
    setEditing(null);
    setNotice(text);
  };
  // Moving someone up or down rewrites the order as it now reads: anyone free goes to the first.
  const move = async (index: number, by: -1 | 1) => {
    const order = [...rows];
    const [it] = order.splice(index, 1);
    if (!it) return;
    order.splice(index + by, 0, it);
    for (const [i, r] of order.entries()) {
      if (r.sort !== i) await write.mutateAsync({ id: r.id, body: { sort: i } });
    }
  };
  return (
    <section className="card glass stack">
      <SectionHead title="Staff">
        <span className="sp" />
        {editing === null && rows.length > 0 && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing("new")}>
            <Plus className="icon" aria-hidden="true" />
            Add someone
          </button>
        )}
      </SectionHead>
      <p className="lede small">
        Who people book by name. Customers see the name you choose and a photo, nothing else.
      </p>
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      {staff.isPending && <div className="skeleton sk-line" />}
      {staff.isError && (
        <ErrorState
          title="Could not load your staff"
          text={problemOf(staff.error).detail}
          onRetry={() => void staff.refetch()}
        />
      )}
      {staff.isSuccess && rows.length === 0 && editing !== "new" && (
        <div className="state state-left">
          <h3>No one yet</h3>
          <p>Add the people who give your services, and agents can book them by name.</p>
          <div>
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
              <Plus className="icon" aria-hidden="true" />
              Add someone
            </button>
          </div>
        </div>
      )}
      {editing === "new" && (
        <StaffEditor
          initial={undefined}
          services={offered}
          currency={currency}
          pending={write.isPending}
          error={write.error ? problemOf(write.error) : null}
          onCancel={() => setEditing(null)}
          onSubmit={(body) => write.mutate({ body }, { onSuccess: (s) => done(`${s.publicName} added.`) })}
        />
      )}
      <div className="stack">
        {rows.map((s, i) => (
          <StaffLine
            key={s.id}
            person={s}
            onUp={i > 0 ? () => void move(i, -1) : undefined}
            onDown={i < rows.length - 1 ? () => void move(i, 1) : undefined}
            services={offered}
            currency={currency}
            editing={editing === s.id}
            pending={write.isPending}
            error={editing === s.id && write.error ? problemOf(write.error) : null}
            onEdit={() => {
              write.reset();
              setEditing(s.id);
            }}
            onCancel={() => setEditing(null)}
            onSave={(body) => write.mutate({ id: s.id, body }, { onSuccess: () => done(`${s.publicName} saved.`) })}
            onArchive={() =>
              write.mutate(
                { id: s.id, body: {}, archive: true },
                { onSuccess: () => done(`${s.publicName} is off the list.`) },
              )
            }
            onRestore={() =>
              write.mutate({ id: s.id, body: { active: true } }, { onSuccess: () => done(`${s.publicName} is back.`) })
            }
          />
        ))}
      </div>
    </section>
  );
}

function Avatar({ name, photo, size = 36 }: { name: string; photo: string | null; size?: number }) {
  return photo ? (
    <img className="staff-avatar" src={photo} alt="" width={size} height={size} />
  ) : (
    <span className="staff-avatar is-initials" style={{ width: size, height: size }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function StaffLine({
  person: s,
  services,
  currency,
  editing,
  pending,
  error,
  onEdit,
  onCancel,
  onSave,
  onArchive,
  onRestore,
  onUp,
  onDown,
}: {
  person: StaffView;
  services: readonly ServiceRow[];
  currency: string;
  editing: boolean;
  pending: boolean;
  error: ReturnType<typeof problemOf> | null;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: StaffBody) => void;
  onArchive: () => void;
  onRestore: () => void;
  onUp: (() => void) | undefined;
  onDown: (() => void) | undefined;
}) {
  const gives = s.services
    .map((x) => services.find((v) => v.id === x.serviceId)?.name)
    .filter((n): n is string => Boolean(n));
  return (
    <div className={`catalogue-row row-glass${s.active ? "" : " is-archived"}`}>
      <div className="catalogue-main staff-main">
        <Avatar name={s.name} photo={s.photo} />
        <div>
          <div className="t">
            <span className="staff-names">
              <b>{s.publicName}</b>
              {s.name !== s.publicName && (
                <span className="hint staff-fullname" title={s.name}>
                  {s.name}
                </span>
              )}
            </span>
            {!s.active && <span className="pill pill-xs">Off the list</span>}
            {s.source !== "builtin" && (
              <span className="pill pill-xs">From {s.source === "phorest" ? "Phorest" : s.source}</span>
            )}
          </div>
          <div className="s">
            {gives.length ? gives.join(" · ") : "No services yet"}
            {s.hours ? " · own hours" : ""}
            {s.calendar ? ` · ${s.calendar.name}` : ""}
          </div>
        </div>
      </div>
      <div className="rowx">
        {s.active && (onUp || onDown) && (
          <span className="order-btns">
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={`Move ${s.publicName} up`}
              disabled={!onUp || pending}
              onClick={onUp}
            >
              <ArrowUp className="icon-sm" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={`Move ${s.publicName} down`}
              disabled={!onDown || pending}
              onClick={onDown}
            >
              <ArrowDown className="icon-sm" aria-hidden="true" />
            </button>
          </span>
        )}
        {s.active ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-expanded={editing}>
              Edit
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive} disabled={pending}>
              Take off the list
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRestore} disabled={pending}>
            Put back
          </button>
        )}
      </div>
      {editing && (
        <div className="wide">
          <StaffEditor
            initial={s}
            services={services}
            currency={currency}
            pending={pending}
            error={error}
            onCancel={onCancel}
            onSubmit={onSave}
          />
        </div>
      )}
    </div>
  );
}

interface Gives {
  readonly on: boolean;
  /** As typed, in the currency's units; "" for the service's own price. */
  readonly price: string;
  /** In minutes; "" for the service's own length. */
  readonly length: string;
}

function StaffEditor({
  initial,
  services,
  currency,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  initial: StaffView | undefined;
  services: readonly ServiceRow[];
  currency: string;
  pending: boolean;
  error: ReturnType<typeof problemOf> | null;
  onCancel: () => void;
  onSubmit: (body: StaffBody) => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [shown, setShown] = useState(
    initial && initial.publicName !== shownName(initial.name) ? initial.publicName : "",
  );
  const [photo, setPhoto] = useState<string | null>(initial?.photo ?? null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [gives, setGives] = useState<Record<string, Gives>>(() =>
    Object.fromEntries(
      services.map((svc) => {
        const own = initial?.services.find((x) => x.serviceId === svc.id);
        return [
          svc.id,
          {
            on: own !== undefined,
            price:
              own?.priceOverride !== null && own?.priceOverride !== undefined
                ? majorText(own.priceOverride, currency)
                : "",
            length: own?.durationOverrideMin ? String(own.durationOverrideMin) : "",
          },
        ];
      }),
    ),
  );
  const [ownHours, setOwnHours] = useState(initial?.hours !== null && initial?.hours !== undefined);
  const [hours, setHours] = useState<Weekly>(initial?.hours ?? {});
  const [hoursProblem, setHoursProblem] = useState<string | null>(null);
  // A service's own price or length for them opens only when asked for, or when they have one.
  const [ownTerms, setOwnTerms] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        (initial?.services ?? [])
          .filter((x) => x.priceOverride !== null || x.durationOverrideMin !== null)
          .map((x) => x.serviceId),
      ),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Their hours are checked as the business's are: no window that ends before it starts, or overlaps.
    const problem = ownHours ? checkDraft(toDraft(hours)) : null;
    setHoursProblem(problem);
    if (problem) return;
    const list: StaffServiceBody[] = [];
    for (const svc of services) {
      const g = gives[svc.id];
      if (!g?.on) continue;
      const price = g.price.trim() === "" ? null : (parseMajor(g.price, minorUnitsOf(currency)) ?? null);
      list.push({
        service_id: svc.id,
        price_override: price,
        duration_override_min: g.length === "" ? null : Number(g.length),
      });
    }
    onSubmit({
      name: name.trim(),
      ...(shown.trim() ? { public_name: shown.trim() } : initial ? { public_name: null } : {}),
      ...(photo !== (initial?.photo ?? null) ? { photo } : {}),
      services: list,
      hours: ownHours ? hours : null,
    });
  };
  return (
    <form className="stack staff-editor" onSubmit={submit}>
      <div className="staff-head">
        <label className="staff-photo" htmlFor={`${id}-photo`}>
          <Avatar name={name || "?"} photo={photo} size={56} />
          <span className="hint">
            <ImagePlus className="icon-xs" aria-hidden="true" /> {photo ? "Change photo" : "Add a photo"}
          </span>
          <input
            id={`${id}-photo`}
            className="sr-only"
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setPhotoError(null);
              smallPhoto(file).then(setPhoto, (err: Error) => setPhotoError(err.message));
            }}
          />
        </label>
        {photo && (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Take the photo off"
            onClick={() => setPhoto(null)}
          >
            <Trash2 className="icon-sm" aria-hidden="true" />
          </button>
        )}
        <div className="grid2 staff-names">
          <Field
            id={`${id}-name`}
            label="Their name"
            hint="Customers see its first word, unless you set what they see."
          >
            <input
              id={`${id}-name`}
              className="input"
              value={name}
              required
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            id={`${id}-shown`}
            label="Customers see"
            hint={name.trim() && !shown.trim() ? `Default: ${shownName(name)}.` : undefined}
          >
            <input
              id={`${id}-shown`}
              className="input"
              value={shown}
              maxLength={60}
              placeholder={name.trim() ? shownName(name) : ""}
              onChange={(e) => setShown(e.target.value)}
            />
          </Field>
        </div>
      </div>
      {photoError && (
        <p className="hint error" role="alert">
          {photoError}
        </p>
      )}

      <fieldset className="chips-field">
        <legend className="label">Services</legend>
        {services.length === 0 ? (
          <p className="hint">Add a service first.</p>
        ) : (
          <div className="chips">
            {services.map((svc) => (
              <button
                key={svc.id}
                type="button"
                className="chip chip-toggle"
                aria-pressed={gives[svc.id]?.on === true}
                onClick={() =>
                  setGives((g) => ({
                    ...g,
                    [svc.id]: { ...(g[svc.id] ?? { price: "", length: "" }), on: !g[svc.id]?.on },
                  }))
                }
              >
                {svc.name}
              </button>
            ))}
          </div>
        )}
      </fieldset>
      {services
        .filter((svc) => gives[svc.id]?.on)
        .map((svc) => {
          const g = gives[svc.id] as Gives;
          const fixed = svc.price?.model === "fixed";
          if (!ownTerms.has(svc.id)) {
            return (
              <div key={svc.id} className="staff-terms-closed">
                <b className="staff-terms-name">{svc.name}</b>
                <span className="hint"> · its usual price and length · </span>
                <button type="button" className="linkish" onClick={() => setOwnTerms((x) => new Set([...x, svc.id]))}>
                  Own price or length
                </button>
              </div>
            );
          }
          return (
            <div key={svc.id} className="staff-terms row-glass">
              <b className="staff-terms-name">{svc.name}</b>
              {fixed && (
                <Field
                  id={`${id}-${svc.id}-price`}
                  label={svc.price?.per === "person" ? "Their price, per person" : "Their price"}
                  hint={`Default ${describePrice(svc.price, currency)}`}
                >
                  <MoneyInput
                    id={`${id}-${svc.id}-price`}
                    value={g.price}
                    currency={svc.price?.currency ?? currency}
                    placeholder={majorText(svc.price?.value ?? 0, svc.price?.currency ?? currency)}
                    onChange={(price) => setGives((x) => ({ ...x, [svc.id]: { ...g, price } }))}
                  />
                </Field>
              )}
              <DurationPicker
                id={`${id}-${svc.id}-length`}
                legend="Their length"
                value={g.length}
                unit="min"
                presets={ownLengths(svc.durationMin)}
                min={5}
                max={1440}
                onChange={(length) => setGives((x) => ({ ...x, [svc.id]: { ...g, length } }))}
              />
            </div>
          );
        })}

      <Switch checked={ownHours} onChange={setOwnHours}>
        Their own hours
      </Switch>
      {ownHours && (
        <HoursEditor
          person
          initial={hours}
          unset={!initial?.hours}
          title="When they work"
          pending={false}
          error={null}
          onChange={setHours}
        />
      )}
      {initial && <TheirCalendar person={initial} />}
      {hoursProblem && (
        <p className="hint error" role="alert">
          {hoursProblem}
        </p>
      )}
      {error && (
        <p className="hint error" role="alert">
          {error.detail}
        </p>
      )}
      <FormActions>
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          {initial ? "Save" : "Add"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </FormActions>
    </form>
  );
}

/**
 * Their own calendar: one of the calendars connected here, tied to them, so its busy times take only
 * their times off and only their bookings go to it. Chosen, never typed.
 */
function TheirCalendar({ person }: { person: StaffView }) {
  const integrations = useIntegrations();
  const tie = useTieCalendar();
  const calendars = (integrations.data?.connections ?? []).filter((c) => c.card === "calendar" || c.card === "calcom");
  const mine = calendars.find((c) => c.resource_id === person.id);
  const free = calendars.filter((c) => !c.resource_id || c.resource_id === person.id);
  return (
    <fieldset className="chips-field">
      <legend className="label">
        <CalendarDays className="icon-xs" aria-hidden="true" /> Their calendar
      </legend>
      {calendars.length === 0 ? (
        <p className="hint">
          Connect their calendar in <a href="/settings/integrations">Integrations</a>, then choose it here.
        </p>
      ) : (
        <div className="chips" role="radiogroup">
          <label className="chip">
            <input
              type="radio"
              name={`cal-${person.id}`}
              checked={!mine}
              onChange={() => mine && tie.mutate({ connectionId: mine.id, resourceId: null })}
            />
            <span>Shared</span>
          </label>
          {free.map((c) => (
            <label key={c.id} className="chip">
              <input
                type="radio"
                name={`cal-${person.id}`}
                checked={mine?.id === c.id}
                onChange={() => tie.mutate({ connectionId: c.id, resourceId: person.id })}
              />
              <span>
                {c.name}
                {c.account ? ` · ${c.account}` : ""}
              </span>
            </label>
          ))}
        </div>
      )}
      {/* Chosen, it is saved at once: said beside the choice, as Cancel below does not undo it. */}
      {tie.isPending && <p className="hint">Saving…</p>}
      {tie.isSuccess && !tie.isPending && <p className="hint">Saved.</p>}
      {tie.error && (
        <p className="hint error" role="alert">
          {problemOf(tie.error).detail}
        </p>
      )}
    </fieldset>
  );
}
