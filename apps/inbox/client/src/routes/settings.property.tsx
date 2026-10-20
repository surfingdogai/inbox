import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ConnectYourSystem } from "../components/ConnectYourSystem";
import { ErrorState } from "../components/Feedback";
import { Field, FormActions, SectionHead, Switch } from "../components/Form";
import {
  Chips,
  FeesTab,
  NewProperty,
  PoliciesTab,
  PropertyTab,
  RatesTab,
  RoomsTab,
  RulesTab,
} from "../components/Property";
import { Sheet } from "../components/Sheet";
import { ownerCall, problemOf } from "../lib/api";
import {
  KIND_WORDS,
  type OwnerSetup,
  type PropertyView,
  propertyApi,
  useProperty,
  usePropertyWrite,
  useSystemProperties,
} from "../lib/property";
import { useBusiness, useIntegrations, useProfile } from "../lib/queries";
import "../property.css";

const TABS = ["Property", "Rooms", "Rates", "Policies", "Taxes & fees", "House rules & arrival"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/settings/property")({
  // Which tab to open on: the wizard's "Add your prices" opens Rates.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    typeof search.tab === "string" && (TABS as readonly string[]).includes(search.tab)
      ? { tab: search.tab as Tab }
      : {},
  component: PropertyPage,
});

/**
 * A place to stay (ADR-033 §11, S1–S9): how it confirms, in one sentence; its own system, connected
 * and its rooms matched; then the property, rooms, rates, policies, taxes and fees, house rules and
 * arrival, a tab each. Prices and policies are the owner's, set here in person.
 */
function PropertyPage() {
  const property = useProperty();
  const profile = useProfile();
  const business = useBusiness();
  const search = Route.useSearch();
  const [tab, setTab] = useState<Tab>(search.tab ?? "Property");
  if (property.isError) {
    return (
      <div className="card glass">
        <ErrorState
          title="Could not load the property"
          text={problemOf(property.error).detail}
          onRetry={() => void property.refetch()}
        />
      </div>
    );
  }
  if (!property.data || !profile.data) {
    return (
      <div className="card glass" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
      </div>
    );
  }
  const setup = property.data.setup;
  if (!setup) return <NewProperty currency={profile.data.currency} name={business.data?.name ?? ""} />;
  return (
    <>
      <HowItConfirms setup={setup} />
      <YourSystem data={property.data} setup={setup} />
      <section className="card glass stack">
        <fieldset className="seg prop-tabs">
          <legend className="sr-only">Property sections</legend>
          {TABS.map((t) => (
            <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </fieldset>
        {tab === "Property" && <PropertyTab key={setup.property.id} setup={setup} />}
        {tab === "Rooms" && <RoomsTab setup={setup} />}
        {tab === "Rates" && <RatesTab setup={setup} />}
        {tab === "Policies" && <PoliciesTab setup={setup} collect={property.data.collect} />}
        {tab === "Taxes & fees" && <FeesTab key={setup.fees.length} setup={setup} />}
        {tab === "House rules & arrival" && (
          <RulesTab
            key={setup.property.id}
            setup={setup}
            arrivalHours={property.data.stays.arrivalDetailsHours}
            canSeal={property.data.can_seal}
          />
        )}
      </section>
    </>
  );
}

const MODES = [
  { value: "request", label: "I confirm each one" },
  { value: "allotment", label: "At once, in rooms I keep for direct guests" },
  { value: "connected", label: "At once, by my property system" },
] as const;

/** S1: how a stay confirms here, said as the guests' assistants are told it, and the owner's to change. */
function HowItConfirms({ setup }: { setup: PropertyView }) {
  const p = setup.property;
  const save = usePropertyWrite(propertyApi.save);
  const connected = p.connectorId !== null;
  return (
    <section className="card glass stack">
      <SectionHead title={p.name}>
        <span className="pill pill-xs">{KIND_WORDS[p.kind] ?? p.kind}</span>
      </SectionHead>
      <p className="reads-as">{setup.sentence}</p>
      <Chips
        legend="How a stay is confirmed"
        value={p.mode}
        options={MODES.filter((m) => m.value !== "connected" || connected)}
        onChange={(mode) => save.mutate({ id: p.id, mode })}
      />
      {p.mode === "allotment" && (
        <p className="hint">
          Inside the nights you keep (<Link to="/settings/availability">Availability</Link>), a guest's assistant books
          at once. Outside them, you answer.
        </p>
      )}
      {p.mode === "connected" && (
        <>
          <Switch
            checked={p.instant}
            disabled={!setup.instant_unlocked || save.isPending}
            onChange={(instant) => save.mutate({ id: p.id, instant })}
          >
            Confirm at once when your system says a room is free
          </Switch>
          {!setup.instant_unlocked && (
            <p className="hint">
              Once a first stay has been written to your system and read back, you can switch this on.
            </p>
          )}
          <Chips
            legend="Only when your system was read in the last"
            value={p.freshMinutes}
            options={[5, 15, 60].map((n) => ({ value: n, label: `${n} min` }))}
            onChange={(fresh_minutes) => save.mutate({ id: p.id, fresh_minutes })}
          />
        </>
      )}
      {save.isError && <p className="hint error">{problemOf(save.error).detail}</p>}
    </section>
  );
}

/**
 * S2: the property's own system. Its connections that hold rooms, each with the property and rooms
 * matched; the calendar links of other channels, each a room's hint; and the systems to connect.
 */
function YourSystem({ data, setup }: { data: OwnerSetup; setup: PropertyView }) {
  const integrations = useIntegrations();
  const systems = (integrations.data?.connections ?? []).filter((c) => c.capabilities.includes("stay_inventory"));
  const [mapping, setMapping] = useState<{ id: string; title: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [linking, setLinking] = useState(false);
  const sync = usePropertyWrite(propertyApi.sync);
  const calendar = usePropertyWrite(propertyApi.calendar);
  const rooms = setup.rooms.filter((r) => r.active);
  return (
    <section className="card glass stack">
      {systems.length > 0 && (
        <>
          <SectionHead title="Your system" />
          {systems.map((c) => (
            <div key={c.id} className="catalogue-row row-glass">
              <div className="catalogue-main">
                <div className="t">
                  <b>{c.title}</b> · {c.account}
                </div>
                <div className="s">
                  {setup.property.connectorId === c.id
                    ? `${setup.property.name}, its rooms matched`
                    : "Not matched to this property yet"}
                </div>
              </div>
              <div className="rowx">
                {setup.property.connectorId === c.id && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={sync.isPending}
                    onClick={() => sync.mutate(undefined)}
                  >
                    <RefreshCw className="icon-sm" aria-hidden="true" />
                    Read now
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setMapping({ id: c.id, title: c.title })}
                >
                  {setup.property.connectorId === c.id ? "Rooms" : "Choose the property"}
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      {systems.length === 0 && !hidden && (
        <ConnectYourSystem
          groups={["lodging", "calendars"]}
          skip={["calcom", "calendly", "ics_feed"]}
          lodging
          lede="Calendar links from your other channels show the nights that are likely taken. A property system, once connected, takes each stay first."
          onOpen={(card) => (card.id === "calendar" ? setLinking(true) : undefined)}
          onSkip={() => setHidden(true)}
        />
      )}
      {linking && <CalendarLinkSheet rooms={rooms} onClose={() => setLinking(false)} />}
      {data.calendars.length > 0 && rooms.length > 0 && (
        <>
          <SectionHead title="Calendars from other channels" />
          <p className="lede small">
            A night another calendar shows taken is a hint for you, never a reason to say no on its own.
          </p>
          {data.calendars.map((c) => (
            <div key={c.id} className="grid2">
              <div className="label-line">{c.name}</div>
              <select
                aria-label={`Which room ${c.name} is`}
                className="input"
                value={c.room_type_id ?? ""}
                onChange={(e) =>
                  calendar.mutate({ connector_id: c.id, room_type_id: e.target.value || null, units: 1 })
                }
              >
                <option value="">Not one of the rooms</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </>
      )}
      {(sync.isError || calendar.isError) && (
        <p className="hint error">{problemOf(sync.error ?? calendar.error).detail}</p>
      )}
      {mapping && <SystemSheet setup={setup} connection={mapping} onClose={() => setMapping(null)} />}
    </section>
  );
}

/**
 * A calendar link from another channel (Airbnb, Booking.com, Vrbo), added here in one sheet: the link,
 * and which room its nights are. Its nights are hints for you, never a reason to say no on their own.
 */
function CalendarLinkSheet({ rooms, onClose }: { rooms: PropertyView["rooms"]; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [room, setRoom] = useState(rooms[0]?.id ?? "");
  const map = usePropertyWrite(propertyApi.calendar);
  const add = usePropertyWrite((link: string) =>
    ownerCall<{ id: string }>("POST", "/v1/owner/integrations", { body: { kind: "ics", values: { url: link } } }),
  );
  const busy = add.isPending || map.isPending;
  const error = add.error ?? map.error;
  return (
    <Sheet title="Calendar link" onClose={onClose}>
      <div className="stack">
        <p className="lede small">
          The private link a channel gives for its calendar of a room: it ends in .ics. One link for each room.
        </p>
        <Field id="cl-url" label="Calendar link">
          <input
            id="cl-url"
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://…/calendar.ics"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field id="cl-room" label="Which room">
          <select id="cl-room" className="input" value={room} onChange={(e) => setRoom(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        {error && <p className="hint error">{problemOf(error).detail}</p>}
        <FormActions>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={url.trim().length < 8 || !room || busy}
            onClick={() =>
              add.mutate(url.trim(), {
                onSuccess: (made) =>
                  map.mutate(
                    { connector_id: (made as { id: string }).id, room_type_id: room, units: 1 },
                    { onSuccess: onClose },
                  ),
              })
            }
          >
            Add it
          </button>
        </FormActions>
      </div>
    </Sheet>
  );
}

/**
 * Which property in the system this is, and which room each of its rooms is: matched by name where
 * they agree, new where there is none here, and said back in one sentence before anything is saved.
 */
function SystemSheet({
  setup,
  connection,
  onClose,
}: {
  setup: PropertyView;
  connection: { id: string; title: string };
  onClose: () => void;
}) {
  const props = useSystemProperties(connection.id);
  const list = props.data?.properties ?? [];
  const [chosen, setChosen] = useState<string | null>(setup.property.externalId);
  const ext = list.find((p) => p.id === chosen) ?? (list.length === 1 ? list[0] : undefined);
  const ours = setup.rooms.filter((r) => r.active);
  const guess = (name: string, id: string) =>
    ours.find((r) => r.externalId === id)?.id ??
    ours.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ??
    "new";
  const [rooms, setRooms] = useState<Record<string, string>>({});
  const pick = (id: string, name: string) => rooms[id] ?? guess(name, id);
  const save = usePropertyWrite(propertyApi.mapSystem);
  const made = ext ? ext.rooms.filter((r) => pick(r.id, r.name) === "new").length : 0;
  return (
    <Sheet title={`Connect ${connection.title}`} onClose={onClose}>
      <div className="stack">
        {props.isPending && <div className="skeleton sk-line" />}
        {props.isError && <p className="hint error">{problemOf(props.error).detail}</p>}
        {list.length > 1 && (
          <fieldset className="stack">
            <legend className="label">Which property is this?</legend>
            {list.map((p) => (
              <button
                key={p.id}
                type="button"
                className={chosen === p.id ? "pick is-picked" : "pick"}
                onClick={() => setChosen(p.id)}
              >
                <b>{p.name}</b>
                <span className="s">
                  {p.rooms.length} room type{p.rooms.length === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </fieldset>
        )}
        {ext && (
          <>
            <div className="label">Its rooms</div>
            {ext.rooms.map((r) => (
              <Field key={r.id} id={`m-${r.id}`} label={`${r.name} · ${r.units}`}>
                <select
                  id={`m-${r.id}`}
                  className="input"
                  value={pick(r.id, r.name)}
                  onChange={(e) => setRooms({ ...rooms, [r.id]: e.target.value })}
                >
                  <option value="new">A new room type, as your system has it</option>
                  {ours.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
            <p className="reads-as">
              This inbox is {ext.name} in {connection.title}, with {ext.rooms.length} room type
              {ext.rooms.length === 1 ? "" : "s"}
              {made ? `, ${made} of them new here` : ""}. Stays are written there first. Nothing confirms on its own
              until you say so, after a first stay is written and read back.
            </p>
          </>
        )}
        {save.isError && <p className="hint error">{problemOf(save.error).detail}</p>}
        <FormActions>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ext || save.isPending}
            onClick={() =>
              ext &&
              save.mutate(
                {
                  connector_id: connection.id,
                  external_property_id: ext.id,
                  property_id: setup.property.id,
                  rooms: ext.rooms.map((r) => ({ external_id: r.id, room_type_id: pick(r.id, r.name) })),
                },
                { onSuccess: onClose },
              )
            }
          >
            Connect
          </button>
        </FormActions>
      </div>
    </Sheet>
  );
}
