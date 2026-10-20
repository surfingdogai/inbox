import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { Plus } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { majorText, parseMajor } from "../lib/actions";
import { problemOf } from "../lib/api";
import { minorUnitsOf } from "../lib/currencies";
import { formatMoney } from "../lib/format";
import {
  type AfterFee,
  AMENITY_WORDS,
  BASIS_WORDS,
  type BalanceChoice,
  BED_WORDS,
  type DepositChoice,
  EVERY_DAY,
  EXTRA_WORDS,
  FREE_DAYS,
  KIND_WORDS,
  MEAL_WORDS,
  type NoShowFee,
  type PolicyChoice,
  type PropertyView,
  paymentWords,
  policyChoiceOf,
  policyWords,
  propertyApi,
  RULE_WORDS,
  STANDARD_PLAN,
  seasonWords,
  usePropertyWrite,
  WEEKDAYS,
} from "../lib/property";
import { useIntegrations, useOwnerLocale } from "../lib/queries";
import { CurrencySelect, MoneyInput, Stepper } from "./Choosers";
import { Toast } from "./Feedback";
import { Field, FormActions, SectionHead, Switch } from "./Form";

type Room = PropertyView["rooms"][number];
type Plan = PropertyView["plans"][number];
type Fee = PropertyView["fees"][number];

/** One choice of a few, each a chip. */
export function Chips<T extends string | number>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="chips-field">
      <legend className="label">{legend}</legend>
      <div className="chips" role="radiogroup">
        {options.map((o) => (
          <label key={String(o.value)} className="chip">
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Any of a few, each a chip. */
function Toggles({
  legend,
  value,
  words,
  onChange,
}: {
  legend: string;
  value: readonly string[];
  words: Readonly<Record<string, string>>;
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset className="chips-field">
      <legend className="label">{legend}</legend>
      <div className="chips">
        {Object.entries(words).map(([k, label]) => (
          <label key={k} className="chip">
            <input
              type="checkbox"
              checked={value.includes(k)}
              onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TimeField({
  id,
  label,
  value,
  onChange,
  optional,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
}) {
  return (
    <Field id={id} label={label} optional={optional}>
      <input
        id={id}
        className="input"
        type="time"
        step={900}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function Problem({ error }: { error: unknown }) {
  return error ? (
    <p className="hint error" role="alert">
      {problemOf(error).detail}
    </p>
  ) : null;
}

const HOURS = (list: readonly number[], unit = "h") => list.map((n) => ({ value: n, label: `${n} ${unit}` }));

// ——— Property ————————————————————————————————————————————————————————————————————————————————

/** The first form: a name, a kind, a currency, the check-in and check-out times. Everything else later. */
export function NewProperty({ currency, name: suggested }: { currency: string; name: string }) {
  const [name, setName] = useState(suggested);
  const [kind, setKind] = useState("guesthouse");
  const [cur, setCur] = useState(currency);
  const [checkIn, setCheckIn] = useState("15:00");
  const [checkOut, setCheckOut] = useState("11:00");
  const [town, setTown] = useState("");
  const save = usePropertyWrite(propertyApi.save);
  return (
    <section className="card glass stack">
      <SectionHead title="A place to stay" />
      <p className="lede small">Guests' assistants see your rooms, ask for dates and book what you offer.</p>
      <Field id="p-name" label="Name">
        <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid2">
        <Field id="p-kind" label="Kind">
          <select id="p-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_WORDS).map(([k, w]) => (
              <option key={k} value={k}>
                {w}
              </option>
            ))}
          </select>
        </Field>
        <Field id="p-cur" label="Prices in">
          <CurrencySelect id="p-cur" value={cur} onChange={setCur} />
        </Field>
        <TimeField id="p-in" label="Check-in from" value={checkIn} onChange={setCheckIn} />
        <TimeField id="p-out" label="Check-out until" value={checkOut} onChange={setCheckOut} />
      </div>
      <TownField id="p-town" value={town} onChange={setTown} />
      <Problem error={save.error} />
      <FormActions>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!name.trim() || save.isPending}
          onClick={() =>
            save.mutate({
              name: name.trim(),
              kind,
              currency: cur,
              check_in_from: checkIn,
              check_out_until: checkOut,
              ...(town.trim() ? { town: town.trim() } : {}),
            })
          }
        >
          Save
        </button>
      </FormActions>
    </section>
  );
}

/** The town the place is in: how its guests read a time ("23:59 Oaxaca time") and its address. */
export function TownField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field id={id} label="Town" optional hint="Guests read your times by it: “until 23:59, Oaxaca time”.">
      <input
        id={id}
        className="input"
        autoComplete="address-level2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** Whether any plan guests are offered takes money or a card before arrival. */
function takesMoneyNow(setup: PropertyView): boolean {
  return setup.plans.some(
    (x) => x.active && (x.deposit.kind !== "none" || x.balance.when === "days_before" || x.guarantee === "card"),
  );
}

export function PropertyTab({ setup }: { setup: PropertyView }) {
  const p = setup.property;
  const [d, setD] = useState(() => ({
    town: p.locality ?? "",
    name: p.name,
    kind: p.kind,
    currency: p.currency,
    checkInFrom: p.checkInFrom,
    checkInUntil: p.checkInUntil ?? "",
    checkOutUntil: p.checkOutUntil,
    sameDayUntil: p.sameDayUntil ?? "",
    answerHours: p.answerHours,
    quoteValidHours: p.quoteValidHours,
    payWithinHours: p.payWithinHours,
    holdMinutes: p.holdMinutes,
    maxNights: String(p.maxNights),
    vat: p.pricesInclude !== null,
    vatName: p.pricesInclude?.name ?? "VAT",
    vatPercent: p.pricesInclude ? String(p.pricesInclude.rateBp / 100) : "",
  }));
  const set = (next: Partial<typeof d>) => setD((x) => ({ ...x, ...next }));
  const save = usePropertyWrite(propertyApi.save);
  const [saved, setSaved] = useState(false);
  const vatBp = Math.round(Number(d.vatPercent.replace(",", ".")) * 100);
  return (
    <div className="stack">
      {saved && <Toast tone="success" text="Saved." onDismiss={() => setSaved(false)} />}
      <Field id="pt-name" label="Name">
        <input id="pt-name" className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid2">
        <Field id="pt-kind" label="Kind">
          <select id="pt-kind" className="input" value={d.kind} onChange={(e) => set({ kind: e.target.value })}>
            {Object.entries(KIND_WORDS).map(([k, w]) => (
              <option key={k} value={k}>
                {w}
              </option>
            ))}
          </select>
        </Field>
        <Field id="pt-cur" label="Prices in">
          <CurrencySelect id="pt-cur" value={d.currency} onChange={(currency) => set({ currency })} />
        </Field>
        <TimeField id="pt-in" label="Check-in from" value={d.checkInFrom} onChange={(v) => set({ checkInFrom: v })} />
        <TimeField
          id="pt-in-until"
          label="Check-in until"
          optional
          value={d.checkInUntil}
          onChange={(v) => set({ checkInUntil: v })}
        />
        <TimeField
          id="pt-out"
          label="Check-out until"
          value={d.checkOutUntil}
          onChange={(v) => set({ checkOutUntil: v })}
        />
        <TimeField
          id="pt-same"
          label="Same-day stays until"
          optional
          value={d.sameDayUntil}
          onChange={(v) => set({ sameDayUntil: v })}
        />
      </div>
      <TownField id="pt-town" value={d.town} onChange={(town) => set({ town })} />
      <Chips
        legend="You answer a request within"
        value={d.answerHours}
        options={HOURS([1, 4, 12, 24])}
        onChange={(answerHours) => set({ answerHours })}
      />
      <Chips
        legend="A quote stays open for"
        value={d.quoteValidHours}
        options={HOURS([2, 12, 24, 48])}
        onChange={(quoteValidHours) => set({ quoteValidHours })}
      />
      {/* Timers that matter only where they apply: a payment window where a plan takes money now, a
          hold where a room confirms at once. */}
      {takesMoneyNow(setup) && (
        <Chips
          legend="What is due now is paid within"
          value={d.payWithinHours}
          options={HOURS([1, 6, 24, 48])}
          onChange={(payWithinHours) => set({ payWithinHours })}
        />
      )}
      {p.mode !== "request" && (
        <Chips
          legend="A guest's assistant may hold a room for"
          value={d.holdMinutes}
          options={HOURS([10, 20, 30, 60], "min")}
          onChange={(holdMinutes) => set({ holdMinutes })}
        />
      )}
      <Stepper
        id="pt-max"
        label="Longest stay"
        value={d.maxNights}
        onChange={(maxNights) => set({ maxNights })}
        min={1}
        max={90}
        suffix="nights"
      />
      <Switch checked={d.vat} onChange={(vat) => set({ vat })}>
        Prices include a tax
      </Switch>
      {d.vat && (
        <div className="grid2">
          <Field id="pt-vat" label="Its name">
            <input id="pt-vat" className="input" value={d.vatName} onChange={(e) => set({ vatName: e.target.value })} />
          </Field>
          <Field id="pt-vat-rate" label="Rate, in %">
            <input
              id="pt-vat-rate"
              className="input"
              inputMode="decimal"
              value={d.vatPercent}
              onChange={(e) => set({ vatPercent: e.target.value })}
            />
          </Field>
        </div>
      )}
      <Problem error={save.error} />
      <FormActions>
        <button
          type="button"
          className="btn btn-primary"
          disabled={save.isPending || (d.vat && !(vatBp >= 1 && vatBp <= 10_000))}
          onClick={() =>
            save.mutate(
              {
                id: p.id,
                name: d.name.trim(),
                kind: d.kind,
                currency: d.currency,
                check_in_from: d.checkInFrom,
                check_in_until: d.checkInUntil || null,
                check_out_until: d.checkOutUntil,
                same_day_until: d.sameDayUntil || null,
                answer_hours: d.answerHours,
                quote_valid_hours: d.quoteValidHours,
                pay_within_hours: d.payWithinHours,
                hold_minutes: d.holdMinutes,
                max_nights: Number(d.maxNights),
                prices_include: d.vat ? { name: d.vatName.trim() || "VAT", rate_bp: vatBp } : null,
                town: d.town.trim() || null,
              },
              { onSuccess: () => setSaved(true) },
            )
          }
        >
          Save
        </button>
      </FormActions>
    </div>
  );
}

// ——— Rooms ———————————————————————————————————————————————————————————————————————————————————

export function RoomsTab({ setup }: { setup: PropertyView }) {
  const [editing, setEditing] = useState<string | null>(null);
  const archive = usePropertyWrite(propertyApi.archiveRoom);
  const rooms = setup.rooms.filter((r) => r.active);
  return (
    <div className="stack">
      <SectionHead title="Rooms">
        <span className="sp" />
        {editing === null && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing("new")}>
            <Plus className="icon" aria-hidden="true" />
            New room type
          </button>
        )}
      </SectionHead>
      {rooms.length === 0 && editing !== "new" && <p className="hint">No rooms yet. Add each kind of room once.</p>}
      {editing === "new" && <RoomEditor propertyId={setup.property.id} onDone={() => setEditing(null)} />}
      {rooms.map((r) =>
        editing === r.id ? (
          <RoomEditor key={r.id} propertyId={setup.property.id} room={r} onDone={() => setEditing(null)} />
        ) : (
          <div key={r.id} className={clsx("catalogue-row row-glass", !r.offered && "is-archived")}>
            <div className="catalogue-main">
              <div className="t">
                <b>{r.name}</b>
                {!r.offered && <span className="pill pill-xs">Not offered</span>}
              </div>
              <div className="s">
                {r.units} room{r.units === 1 ? "" : "s"} · up to {r.capacity.total} guest
                {r.capacity.total === 1 ? "" : "s"}
                {r.beds.length > 0 && ` · ${r.beds.map((b) => `${b.count} ${BED_WORDS[b.type] ?? b.type}`).join(", ")}`}
              </div>
            </div>
            <div className="rowx">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(r.id)}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={archive.isPending}
                onClick={() => archive.mutate(r.id)}
              >
                Archive
              </button>
            </div>
          </div>
        ),
      )}
      <Problem error={archive.error} />
    </div>
  );
}

function RoomEditor({ propertyId, room, onDone }: { propertyId: string; room?: Room; onDone: () => void }) {
  const [d, setD] = useState(() => ({
    name: room?.name ?? "",
    units: String(room?.units ?? 1),
    adults: String(room?.capacity.adults ?? 2),
    children: String(room?.capacity.children ?? 0),
    bed: room?.beds[0]?.type ?? "double",
    beds: String(room?.beds[0]?.count ?? 1),
    amenities: [...(room?.amenities ?? [])],
    accessible: room?.accessible ?? false,
    offered: room?.offered ?? true,
  }));
  const set = (next: Partial<typeof d>) => setD((x) => ({ ...x, ...next }));
  const save = usePropertyWrite(propertyApi.room);
  const adults = Number(d.adults);
  const children = Number(d.children);
  return (
    <div className="card stack">
      <Field id="r-name" label="Name">
        <input
          id="r-name"
          className="input"
          placeholder="Double room with garden view"
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <div className="grid2">
        <Stepper
          id="r-units"
          label="How many of these"
          value={d.units}
          onChange={(units) => set({ units })}
          min={1}
          max={500}
        />
        <Stepper id="r-adults" label="Adults" value={d.adults} onChange={(a) => set({ adults: a })} min={1} max={20} />
        <Stepper
          id="r-children"
          label="Children as well"
          value={d.children}
          onChange={(c) => set({ children: c })}
          min={0}
          max={10}
        />
        <div className="grid2">
          <Field id="r-bed" label="Beds">
            <select id="r-bed" className="input" value={d.bed} onChange={(e) => set({ bed: e.target.value })}>
              {Object.entries(BED_WORDS).map(([k, w]) => (
                <option key={k} value={k}>
                  {w}
                </option>
              ))}
            </select>
          </Field>
          <Stepper id="r-beds" label="How many" value={d.beds} onChange={(beds) => set({ beds })} min={1} max={20} />
        </div>
      </div>
      <Toggles
        legend="In the room"
        value={d.amenities}
        words={AMENITY_WORDS}
        onChange={(amenities) => set({ amenities })}
      />
      <Switch checked={d.accessible} onChange={(accessible) => set({ accessible })}>
        Step-free and accessible
      </Switch>
      <Switch checked={d.offered} onChange={(offered) => set({ offered })}>
        Offered to guests
      </Switch>
      <Problem error={save.error} />
      <FormActions>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!d.name.trim() || save.isPending}
          onClick={() =>
            save.mutate(
              {
                ...(room ? { id: room.id } : {}),
                property_id: propertyId,
                name: d.name.trim(),
                units: Number(d.units),
                capacity: { adults, children, total: adults + children },
                beds: [{ type: d.bed, count: Number(d.beds) }],
                amenities: d.amenities,
                accessible: d.accessible,
                offered: d.offered,
              },
              { onSuccess: onDone },
            )
          }
        >
          Save
        </button>
      </FormActions>
    </div>
  );
}

// ——— Rates ———————————————————————————————————————————————————————————————————————————————————

export function RatesTab({ setup }: { setup: PropertyView }) {
  const plans = setup.plans.filter((p) => p.active);
  const rooms = setup.rooms.filter((r) => r.active);
  const [chosen, setPlanId] = useState(plans[0]?.id ?? "");
  const planId = chosen || plans[0]?.id || "";
  const currency = setup.property.currency;
  const locale = useOwnerLocale();
  const start = usePropertyWrite(propertyApi.plan);
  const connectorId = setup.property.mode === "connected" ? setup.property.connectorId : null;
  const system = useIntegrations().data?.connections.find((c) => c.id === connectorId)?.title ?? null;
  if (rooms.length === 0) return <p className="hint">Add your rooms first, then their prices.</p>;
  if (plans.length === 0) {
    return (
      <div className="state state-left">
        {connectorId && system ? (
          // Priced by the property's own system: no price to type in again, only the terms to set here.
          <p>
            Prices come from your {system} calendar, its first daily price: change them in {system}. Here you set the
            terms, when guests can cancel and any deposit.
          </p>
        ) : (
          <p>Set a price a night for each room. Breakfast or non-refundable plans can come later, in Policies.</p>
        )}
        <div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(
                { property_id: setup.property.id, ...STANDARD_PLAN },
                { onSuccess: (r) => setPlanId((r as { id: string }).id) },
              )
            }
          >
            {connectorId && system ? "Set the terms" : "Add your prices"}
          </button>
        </div>
        <Problem error={start.error} />
      </div>
    );
  }
  return (
    <div className="stack">
      <Field id="rt-plan" label="Plan">
        <select id="rt-plan" className="input" value={planId} onChange={(e) => setPlanId(e.target.value)}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      {rooms.map((r) => (
        <BaseRate key={`${planId}:${r.id}`} setup={setup} planId={planId} room={r} currency={currency} />
      ))}
      <Seasons key={planId} setup={setup} planId={planId} currency={currency} locale={locale} />
    </div>
  );
}

function BaseRate({
  setup,
  planId,
  room,
  currency,
}: {
  setup: PropertyView;
  planId: string;
  room: Room;
  currency: string;
}) {
  const base = setup.rates.find((x) => x.ratePlanId === planId && x.roomTypeId === room.id && x.fromDate === "");
  const [nightly, setNightly] = useState(base ? majorText(base.nightly, currency) : "");
  const [guests, setGuests] = useState(String(base?.baseGuests ?? Math.min(2, room.capacity.total)));
  const [extra, setExtra] = useState(base?.extraAdult ? majorText(base.extraAdult, currency) : "");
  const save = usePropertyWrite(propertyApi.rates);
  const places = minorUnitsOf(currency);
  const value = parseMajor(nightly, places);
  const extraValue = extra ? parseMajor(extra, places) : null;
  const id = `br-${room.id}`;
  return (
    <div className="card stack">
      <div className="t">
        <b>{room.name}</b>
      </div>
      <div className="grid2">
        <Field id={id} label="A night">
          <MoneyInput
            id={id}
            value={nightly}
            onChange={setNightly}
            currency={currency}
            invalid={!!nightly && value === undefined}
          />
        </Field>
        <Stepper
          id={`${id}-g`}
          label="For guests"
          value={guests}
          onChange={setGuests}
          min={1}
          max={Math.max(1, room.capacity.total)}
        />
        {room.capacity.total > Number(guests) && (
          <Field id={`${id}-x`} label="Each guest more, a night" optional>
            <MoneyInput id={`${id}-x`} value={extra} onChange={setExtra} currency={currency} />
          </Field>
        )}
      </div>
      <Problem error={save.error} />
      <FormActions>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={value === undefined || extraValue === undefined || save.isPending}
          onClick={() =>
            save.mutate({
              rate_plan_id: planId,
              room_type_id: room.id,
              nightly: value ?? 0,
              base_guests: Number(guests),
              extra_adult: extraValue,
            })
          }
        >
          {save.isSuccess ? "Saved" : "Save"}
        </button>
      </FormActions>
    </div>
  );
}

function Seasons({
  setup,
  planId,
  currency,
  locale,
}: {
  setup: PropertyView;
  planId: string;
  currency: string;
  locale: string | undefined;
}) {
  const rooms = setup.rooms.filter((r) => r.active);
  const seasons = setup.rates.filter((x) => x.ratePlanId === planId && x.fromDate !== "");
  const [adding, setAdding] = useState(false);
  const [d, setD] = useState({ room: rooms[0]?.id ?? "", from: "", to: "", weekdays: EVERY_DAY, nightly: "" });
  const save = usePropertyWrite(propertyApi.rates);
  const value = parseMajor(d.nightly, minorUnitsOf(currency));
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name ?? "";
  return (
    <div className="stack">
      <SectionHead title="Seasons and weekends">
        <span className="sp" />
        {!adding && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
            <Plus className="icon" aria-hidden="true" />
            Add a season
          </button>
        )}
      </SectionHead>
      {seasons.length === 0 && !adding && <p className="hint">One price all year. Add a season for other nights.</p>}
      {seasons.map((s) => (
        <div key={`${s.roomTypeId}:${s.fromDate}:${s.weekdays}`} className="catalogue-row row-glass">
          <div className="catalogue-main">
            <div className="t">{seasonWords(s, roomName(s.roomTypeId), currency, locale)}</div>
          </div>
          <div className="rowx">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                save.mutate({
                  rate_plan_id: planId,
                  room_type_id: s.roomTypeId,
                  from_date: s.fromDate,
                  to_date: s.toDate,
                  weekdays: s.weekdays,
                  nightly: s.nightly,
                  remove: true,
                })
              }
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      {adding && (
        <div className="card stack">
          <div className="grid2">
            <Field id="s-room" label="Room">
              <select
                id="s-room"
                className="input"
                value={d.room}
                onChange={(e) => setD({ ...d, room: e.target.value })}
              >
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="s-price" label="A night">
              <MoneyInput
                id="s-price"
                value={d.nightly}
                onChange={(nightly) => setD({ ...d, nightly })}
                currency={currency}
              />
            </Field>
            <Field id="s-from" label="First night">
              <input
                id="s-from"
                className="input"
                type="date"
                value={d.from}
                onChange={(e) => setD({ ...d, from: e.target.value })}
              />
            </Field>
            <Field id="s-to" label="Last night">
              <input
                id="s-to"
                className="input"
                type="date"
                min={d.from}
                value={d.to}
                onChange={(e) => setD({ ...d, to: e.target.value })}
              />
            </Field>
          </div>
          <WeekdayChips value={d.weekdays} onChange={(weekdays) => setD({ ...d, weekdays })} />
          <Problem error={save.error} />
          <FormActions>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!d.room || !d.from || !d.to || d.to < d.from || value === undefined || save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    rate_plan_id: planId,
                    room_type_id: d.room,
                    from_date: d.from,
                    to_date: d.to,
                    weekdays: d.weekdays,
                    nightly: value ?? 0,
                  },
                  { onSuccess: () => setAdding(false) },
                )
              }
            >
              Save
            </button>
          </FormActions>
        </div>
      )}
    </div>
  );
}

export function WeekdayChips({ value, onChange }: { value: number; onChange: (mask: number) => void }) {
  return (
    <fieldset className="chips-field">
      <legend className="label">Nights</legend>
      <div className="chips">
        {WEEKDAYS.map((w) => (
          <label key={w.bit} className="chip">
            <input
              type="checkbox"
              checked={(value & w.bit) !== 0}
              onChange={(e) => {
                const next = e.target.checked ? value | w.bit : value & ~w.bit;
                if (next > 0) onChange(next);
              }}
            />
            <span>{w.short}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ——— Policies (rate plans) ————————————————————————————————————————————————————————————————————

export function PoliciesTab({ setup, collect }: { setup: PropertyView; collect: { links: boolean; cards: boolean } }) {
  const plans = setup.plans.filter((p) => p.active);
  const [editing, setEditing] = useState<string | null>(plans.length === 0 ? "new" : null);
  return (
    <div className="stack">
      <SectionHead title="Plans">
        <span className="sp" />
        {editing === null && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing("new")}>
            <Plus className="icon" aria-hidden="true" />
            New plan
          </button>
        )}
      </SectionHead>
      <p className="lede small">What a stay includes, what cancelling costs, and when it is paid.</p>
      {editing === "new" && (
        <PlanEditor propertyId={setup.property.id} collect={collect} onDone={() => setEditing(null)} />
      )}
      {plans.map((p) =>
        editing === p.id ? (
          <PlanEditor
            key={p.id}
            propertyId={setup.property.id}
            plan={p}
            collect={collect}
            onDone={() => setEditing(null)}
          />
        ) : (
          <div key={p.id} className="catalogue-row row-glass">
            <div className="catalogue-main">
              <div className="t">
                <b>{p.name}</b> · {MEAL_WORDS[p.meal] ?? p.meal}
              </div>
              <div className="s">{policyWords(policyChoiceOf(p.policyPreset))}</div>
              <div className="s">{paymentWords(p.deposit, p.balance, p.guarantee)}</div>
            </div>
            <div className="rowx">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(p.id)}>
                Edit
              </button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

const DEPOSITS: readonly { value: string; label: string; choice: DepositChoice }[] = [
  { value: "none", label: "Nothing now", choice: { kind: "none" } },
  { value: "first_night", label: "First night", choice: { kind: "first_night" } },
  { value: "p20", label: "20%", choice: { kind: "percent", value: 20 } },
  { value: "p30", label: "30%", choice: { kind: "percent", value: 30 } },
  { value: "p50", label: "50%", choice: { kind: "percent", value: 50 } },
  { value: "full", label: "Everything", choice: { kind: "full" } },
];
const depositKey = (d: DepositChoice) =>
  d.kind === "percent" ? `p${d.value ?? 0}` : DEPOSITS.some((x) => x.value === d.kind) ? d.kind : "none";

const BALANCES: readonly { value: string; label: string; choice: BalanceChoice }[] = [
  { value: "at_property", label: "At the property", choice: { when: "at_property" } },
  { value: "d7", label: "7 days before", choice: { when: "days_before", days: 7 } },
  { value: "d14", label: "14 days before", choice: { when: "days_before", days: 14 } },
  { value: "d30", label: "30 days before", choice: { when: "days_before", days: 30 } },
];
const balanceKey = (b: BalanceChoice) => (b.when === "days_before" ? `d${b.days ?? 7}` : "at_property");

function PlanEditor({
  propertyId,
  plan,
  collect,
  onDone,
}: {
  propertyId: string;
  plan?: Plan;
  collect: { links: boolean; cards: boolean };
  onDone: () => void;
}) {
  const initial = plan ? policyChoiceOf(plan.policyPreset) : null;
  const [name, setName] = useState(plan?.name ?? "Flexible");
  const [meal, setMeal] = useState(plan?.meal ?? "room_only");
  const [policy, setPolicy] = useState<PolicyChoice>(
    initial && initial.preset !== "custom"
      ? initial
      : { preset: "free_until", days: 7, after: "first_night", no_show: "full" },
  );
  // Nothing now unless a payment account can take it: a deposit nobody can pay holds every stay up.
  const [deposit, setDeposit] = useState(depositKey(plan?.deposit ?? { kind: "none" }));
  const [balance, setBalance] = useState(balanceKey(plan?.balance ?? { when: "at_property" }));
  const [card, setCard] = useState(plan?.guarantee === "card");
  const save = usePropertyWrite(propertyApi.plan);
  const dep = DEPOSITS.find((x) => x.value === deposit)?.choice ?? { kind: "none" };
  const bal = BALANCES.find((x) => x.value === balance)?.choice ?? { when: "at_property" };
  const custom = initial?.preset === "custom";
  return (
    <div className="card stack">
      <div className="grid2">
        <Field id="pl-name" label="Name">
          <input id="pl-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="pl-meal" label="Includes">
          <select id="pl-meal" className="input" value={meal} onChange={(e) => setMeal(e.target.value)}>
            {Object.entries(MEAL_WORDS).map(([k, w]) => (
              <option key={k} value={k}>
                {w}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {custom && <p className="hint">This plan has steps of its own. Choosing below replaces them.</p>}
      <Chips
        legend="Cancelling"
        value={policy.preset === "non_refundable" ? "non_refundable" : "free_until"}
        options={[
          { value: "free_until", label: "Free until a few days before" },
          { value: "non_refundable", label: "Non-refundable" },
        ]}
        onChange={(v) =>
          setPolicy(
            v === "non_refundable"
              ? { preset: "non_refundable" }
              : { preset: "free_until", days: 7, after: "first_night", no_show: "full" },
          )
        }
      />
      {policy.preset === "free_until" && (
        <>
          <Chips
            legend="Free to cancel until"
            value={policy.days ?? 7}
            options={FREE_DAYS.map((n) => ({ value: n, label: `${n} day${n === 1 ? "" : "s"} before` }))}
            onChange={(days) => setPolicy({ ...policy, days })}
          />
          <Chips<AfterFee>
            legend="After that, cancelling costs"
            value={policy.after ?? "first_night"}
            options={[
              { value: "first_night", label: "The first night" },
              { value: "half", label: "Half" },
              { value: "full", label: "Everything" },
            ]}
            onChange={(after) => setPolicy({ ...policy, after })}
          />
          <Chips<NoShowFee>
            legend="A no-show costs"
            value={policy.no_show ?? "full"}
            options={[
              { value: "first_night", label: "The first night" },
              { value: "full", label: "Everything" },
            ]}
            onChange={(no_show) => setPolicy({ ...policy, no_show })}
          />
        </>
      )}
      <Chips
        legend="Paid when the guest accepts"
        value={deposit}
        options={collect.links ? DEPOSITS : DEPOSITS.filter((x) => x.value === "none" || x.value === deposit)}
        onChange={setDeposit}
      />
      {dep.kind !== "full" && (
        <Chips
          legend="The rest is paid"
          value={balance}
          options={collect.links ? BALANCES : BALANCES.filter((x) => x.value === "at_property" || x.value === balance)}
          onChange={setBalance}
        />
      )}
      {!collect.links && (
        <p className="hint">
          To take a deposit, connect Stripe or Mollie in <Link to="/settings/payments">Payments</Link>.
        </p>
      )}
      {dep.kind === "none" && collect.cards && (
        <Switch checked={card} onChange={setCard}>
          Ask for a card to hold the stay, on your own payment account
        </Switch>
      )}
      <p className="reads-as">
        {policyWords(policy)} {paymentWords(dep, bal, card && dep.kind === "none" ? "card" : "none")}.
      </p>
      <Problem error={save.error} />
      <FormActions>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!name.trim() || save.isPending}
          onClick={() =>
            save.mutate(
              {
                ...(plan ? { id: plan.id } : {}),
                property_id: propertyId,
                name: name.trim(),
                meal,
                policy:
                  policy.preset === "non_refundable"
                    ? { preset: "non_refundable" }
                    : { preset: "free_until", days: policy.days, after: policy.after, no_show: policy.no_show },
                deposit: dep,
                balance: bal,
                guarantee: card && dep.kind === "none" ? "card" : "none",
              },
              { onSuccess: onDone },
            )
          }
        >
          Save
        </button>
      </FormActions>
    </div>
  );
}

// ——— Taxes, fees and extras ————————————————————————————————————————————————————————————————————

interface FeeDraft {
  readonly key: string;
  readonly id?: string | undefined;
  name: string;
  kind: "tax" | "fee";
  basis: Fee["basis"];
  amount: string;
  percent: string;
  collected: "with_booking" | "at_property";
  childUnder: string;
  /** Kept as they are: steps by nightly price and a cap on nights are set through the API. */
  readonly tiers?: Fee["tiers"] | undefined;
  readonly maxNights?: number | null | undefined;
}

const feeDraft = (f: Fee, currency: string): FeeDraft => ({
  key: f.id,
  id: f.id,
  name: f.name,
  kind: f.kind,
  basis: f.basis,
  amount: f.amount === null ? "" : majorText(f.amount, currency),
  percent: f.rateBp === null ? "" : String(f.rateBp / 100),
  collected: f.collected,
  childUnder: f.childExemptUnder === null ? "" : String(f.childExemptUnder),
  tiers: f.tiers,
  maxNights: f.maxNights,
});

export function FeesTab({ setup }: { setup: PropertyView }) {
  const currency = setup.property.currency;
  const [fees, setFees] = useState<FeeDraft[]>(() =>
    setup.fees.filter((f) => f.active).map((f) => feeDraft(f, currency)),
  );
  const save = usePropertyWrite(propertyApi.fees);
  const places = minorUnitsOf(currency);
  const bodies = fees.map((f) => {
    const percent = f.basis === "percent_of_room";
    const tiered = (f.tiers?.length ?? 0) > 0;
    const amount = percent || (tiered && !f.amount) ? null : parseMajor(f.amount, places);
    const rate = percent && f.percent ? Math.round(Number(f.percent.replace(",", ".")) * 100) : null;
    return {
      ok:
        f.name.trim() !== "" &&
        (tiered || (percent ? rate !== null && rate >= 1 && rate <= 10_000 : amount !== undefined)),
      body: {
        ...(tiered
          ? {
              tiers: (f.tiers ?? []).map((t) => ({
                up_to_nightly: t.upToNightly,
                ...(t.amount !== undefined ? { amount: t.amount } : {}),
                ...(t.rateBp !== undefined ? { rate_bp: t.rateBp } : {}),
              })),
            }
          : {}),
        ...(f.maxNights ? { max_nights: f.maxNights } : {}),
        ...(f.id ? { id: f.id } : {}),
        name: f.name.trim(),
        kind: f.kind,
        basis: f.basis,
        amount: amount ?? null,
        rate_bp: rate,
        collected: f.collected,
        child_exempt_under: f.basis !== "per_person_night" || f.childUnder === "" ? null : Number(f.childUnder),
      },
    };
  });
  const change = (i: number, next: Partial<FeeDraft>) =>
    setFees((all) => all.map((f, j) => (j === i ? { ...f, ...next } : f)));
  return (
    <div className="stack">
      <SectionHead title="Taxes and fees">
        <span className="sp" />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() =>
            setFees((all) => [
              ...all,
              {
                key: `new-${all.length}-${Date.now()}`,
                name: "",
                kind: "tax",
                basis: "per_person_night",
                amount: "",
                percent: "",
                collected: "at_property",
                childUnder: "",
              },
            ])
          }
        >
          <Plus className="icon" aria-hidden="true" />
          Add one
        </button>
      </SectionHead>
      <p className="lede small">Every one is in the quote's total, whoever collects it: guests see the whole price.</p>
      {fees.length === 0 && <p className="hint">None. A city or tourist tax goes here, or a cleaning fee.</p>}
      {fees.map((f, i) => (
        <div key={f.key} className="row-glass fee-row stack">
          <Chips
            legend="It is"
            value={f.kind}
            options={[
              { value: "tax", label: "A tax" },
              { value: "fee", label: "A fee" },
            ]}
            onChange={(kind) => change(i, { kind })}
          />
          <div className="grid2">
            <Field id={`f-name-${f.key}`} label="Name">
              <input
                id={`f-name-${f.key}`}
                className="input"
                placeholder="Tourist tax"
                value={f.name}
                onChange={(e) => change(i, { name: e.target.value })}
              />
            </Field>
            <Field id={`f-basis-${f.key}`} label="Charged">
              <select
                id={`f-basis-${f.key}`}
                className="input"
                value={f.basis}
                onChange={(e) => change(i, { basis: e.target.value as Fee["basis"] })}
              >
                {Object.entries(BASIS_WORDS).map(([k, w]) => (
                  <option key={k} value={k}>
                    {w}
                  </option>
                ))}
              </select>
            </Field>
            {f.basis === "percent_of_room" ? (
              <Field id={`f-rate-${f.key}`} label="Rate, in %">
                <input
                  id={`f-rate-${f.key}`}
                  className="input"
                  inputMode="decimal"
                  value={f.percent}
                  onChange={(e) => change(i, { percent: e.target.value })}
                />
              </Field>
            ) : (
              <Field id={`f-amt-${f.key}`} label="Amount">
                <MoneyInput
                  id={`f-amt-${f.key}`}
                  value={f.amount}
                  onChange={(amount) => change(i, { amount })}
                  currency={currency}
                />
              </Field>
            )}
            {/* Only a charge per guest can leave children out. */}
            {f.basis === "per_person_night" && (
              <Stepper
                id={`f-child-${f.key}`}
                label="Children free under"
                value={f.childUnder || "0"}
                onChange={(v) => change(i, { childUnder: v === "0" ? "" : v })}
                min={0}
                max={17}
                suffix="years"
              />
            )}
          </div>
          <Chips
            legend="Collected"
            value={f.collected}
            options={[
              { value: "with_booking", label: "With the booking" },
              { value: "at_property", label: "At the property" },
            ]}
            onChange={(collected) => change(i, { collected })}
          />
          <div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setFees((all) => all.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <Problem error={save.error} />
      <FormActions>
        <button
          type="button"
          className="btn btn-primary"
          disabled={bodies.some((b) => !b.ok) || save.isPending}
          onClick={() => save.mutate({ property_id: setup.property.id, fees: bodies.map((b) => b.body) })}
        >
          {save.isSuccess ? "Saved" : "Save taxes and fees"}
        </button>
      </FormActions>
      <Extras setup={setup} />
    </div>
  );
}

function Extras({ setup }: { setup: PropertyView }) {
  const currency = setup.property.currency;
  const [adding, setAdding] = useState(false);
  const [d, setD] = useState({
    item: "breakfast",
    name: EXTRA_WORDS.breakfast ?? "",
    price: "",
    basis: "per_person_night",
  });
  const save = usePropertyWrite(propertyApi.extra);
  const value = parseMajor(d.price, minorUnitsOf(currency));
  return (
    <div className="stack">
      <SectionHead title="Extras">
        <span className="sp" />
        {!adding && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
            <Plus className="icon" aria-hidden="true" />
            Add an extra
          </button>
        )}
      </SectionHead>
      <p className="lede small">Things here at the property a guest may add: breakfast, parking, a cot.</p>
      {setup.extras
        .filter((x) => x.active)
        .map((x) => (
          <div key={x.id} className="catalogue-row row-glass">
            <div className="catalogue-main">
              <div className="t">
                <b>{x.name}</b>
              </div>
              <div className="s">
                {formatMoney({ value: x.price, currency })} {BASIS_WORDS[x.basis]}
              </div>
            </div>
            <div className="rowx">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  save.mutate({
                    id: x.id,
                    property_id: setup.property.id,
                    item: x.item,
                    name: x.name,
                    price: x.price,
                    basis: x.basis,
                    active: false,
                  })
                }
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      {adding && (
        <div className="card stack">
          <div className="grid2">
            <Field id="x-item" label="What">
              <select
                id="x-item"
                className="input"
                value={d.item}
                onChange={(e) => setD({ ...d, item: e.target.value, name: EXTRA_WORDS[e.target.value] ?? d.name })}
              >
                {Object.entries(EXTRA_WORDS).map(([k, w]) => (
                  <option key={k} value={k}>
                    {w}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="x-name" label="As guests read it">
              <input
                id="x-name"
                className="input"
                value={d.name}
                onChange={(e) => setD({ ...d, name: e.target.value })}
              />
            </Field>
            <Field id="x-price" label="Price">
              <MoneyInput
                id="x-price"
                value={d.price}
                onChange={(price) => setD({ ...d, price })}
                currency={currency}
              />
            </Field>
            <Field id="x-basis" label="Charged">
              <select
                id="x-basis"
                className="input"
                value={d.basis}
                onChange={(e) => setD({ ...d, basis: e.target.value })}
              >
                {(["per_stay", "per_night", "per_person_night"] as const).map((k) => (
                  <option key={k} value={k}>
                    {BASIS_WORDS[k]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Problem error={save.error} />
          <FormActions>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!d.name.trim() || value === undefined || save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    property_id: setup.property.id,
                    item: d.item,
                    name: d.name.trim(),
                    price: value ?? 0,
                    basis: d.basis,
                  },
                  { onSuccess: () => setAdding(false) },
                )
              }
            >
              Save
            </button>
          </FormActions>
        </div>
      )}
    </div>
  );
}

// ——— House rules and arrival ——————————————————————————————————————————————————————————————————

/** When the private arrival details go, from the settings: "two days before arrival". */
export function arrivalWhen(hours: number): string {
  if (hours <= 0) return "never on their own";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1
      ? "the day before arrival"
      : `${["", "one", "two", "three", "four", "five", "six", "seven"][days] ?? days} days before arrival`;
  }
  return `${hours} hours before arrival`;
}

export function RulesTab({
  setup,
  arrivalHours,
  canSeal,
}: {
  setup: PropertyView;
  arrivalHours: number;
  canSeal: boolean;
}) {
  const p = setup.property;
  const [d, setD] = useState(() => ({
    chips: [...p.houseRules.chips],
    quietFrom: p.houseRules.quiet?.[0] ?? "22:00",
    quietTo: p.houseRules.quiet?.[1] ?? "07:00",
    text: p.houseRules.text ?? "",
    childrenWelcome: p.children.welcome,
    freeUnder: String(p.children.freeUnder ?? 0),
    cots: p.children.cots ?? false,
    pets: p.pets.allowed,
    arrivalPublic: p.arrivalPublic ?? "",
    arrivalPrivate: "",
    preArrival: p.preArrivalText ?? "",
    registration: p.registration?.required ?? false,
    registrationNumber: p.registration?.number ?? "",
  }));
  const set = (next: Partial<typeof d>) => setD((x) => ({ ...x, ...next }));
  const save = usePropertyWrite(propertyApi.save);
  const [saved, setSaved] = useState(false);
  return (
    <div className="stack">
      {saved && <Toast tone="success" text="Saved." onDismiss={() => setSaved(false)} />}
      <Toggles legend="House rules" value={d.chips} words={RULE_WORDS} onChange={(chips) => set({ chips })} />
      {d.chips.includes("quiet_hours") && (
        <div className="grid2">
          <TimeField id="h-q1" label="Quiet from" value={d.quietFrom} onChange={(quietFrom) => set({ quietFrom })} />
          <TimeField id="h-q2" label="Until" value={d.quietTo} onChange={(quietTo) => set({ quietTo })} />
        </div>
      )}
      <Field id="h-text" label="Anything else" optional>
        <textarea
          id="h-text"
          className="input"
          rows={2}
          maxLength={500}
          value={d.text}
          onChange={(e) => set({ text: e.target.value })}
        />
      </Field>
      <Switch checked={d.childrenWelcome} onChange={(childrenWelcome) => set({ childrenWelcome })}>
        Children welcome
      </Switch>
      {d.childrenWelcome && (
        <div className="grid2">
          <Stepper
            id="h-free"
            label="Free under"
            value={d.freeUnder}
            onChange={(freeUnder) => set({ freeUnder })}
            min={0}
            max={17}
            suffix="years"
          />
          <Switch checked={d.cots} onChange={(cots) => set({ cots })}>
            Cots on request
          </Switch>
        </div>
      )}
      <Chips
        legend="Pets"
        value={d.pets}
        options={[
          { value: "no", label: "No" },
          { value: "yes", label: "Welcome" },
          { value: "ask", label: "Ask first" },
        ]}
        onChange={(pets) => set({ pets })}
      />
      <Field id="h-arr" label="How to find you" hint="With every quote, so a guest knows where they are going.">
        <textarea
          id="h-arr"
          className="input"
          rows={2}
          maxLength={1_000}
          value={d.arrivalPublic}
          onChange={(e) => set({ arrivalPublic: e.target.value })}
        />
      </Field>
      <Field
        id="h-priv"
        label="Door codes, key box, Wi-Fi"
        hint={
          !canSeal
            ? "Door codes need a secret key on your server (INBOX_SECRET_KEY). See the docs."
            : p.hasArrivalPrivate
              ? `Saved and sealed. Sent only to confirmed guests, ${arrivalWhen(arrivalHours)}. Write here to replace it.`
              : `Sealed when saved, and sent only to confirmed guests, ${arrivalWhen(arrivalHours)}.`
        }
      >
        <textarea
          id="h-priv"
          className="input"
          rows={2}
          maxLength={2_000}
          autoComplete="off"
          disabled={!canSeal}
          value={d.arrivalPrivate}
          onChange={(e) => set({ arrivalPrivate: e.target.value })}
        />
      </Field>
      <Field id="h-pre" label="A few days before arrival" optional>
        <textarea
          id="h-pre"
          className="input"
          rows={2}
          maxLength={2_000}
          value={d.preArrival}
          onChange={(e) => set({ preArrival: e.target.value })}
        />
      </Field>
      <Switch checked={d.registration} onChange={(registration) => set({ registration })}>
        Where you are, a short-stay registration number is shown at booking
      </Switch>
      {d.registration && (
        <Field id="h-reg" label="Your registration number">
          <input
            id="h-reg"
            className="input"
            value={d.registrationNumber}
            onChange={(e) => set({ registrationNumber: e.target.value })}
          />
        </Field>
      )}
      <Problem error={save.error} />
      <FormActions>
        <button
          type="button"
          className="btn btn-primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              {
                id: p.id,
                house_rules: {
                  chips: d.chips,
                  ...(d.chips.includes("quiet_hours") ? { quiet: [d.quietFrom, d.quietTo] } : {}),
                  ...(d.text.trim() ? { text: d.text.trim() } : {}),
                },
                children: {
                  welcome: d.childrenWelcome,
                  ...(d.childrenWelcome ? { free_under: Number(d.freeUnder), cots: d.cots } : {}),
                },
                pets: { allowed: d.pets },
                arrival_public: d.arrivalPublic.trim() || null,
                ...(canSeal && d.arrivalPrivate.trim() ? { arrival_private: d.arrivalPrivate.trim() } : {}),
                pre_arrival_text: d.preArrival.trim() || null,
                registration: d.registration
                  ? { required: true, ...(d.registrationNumber.trim() ? { number: d.registrationNumber.trim() } : {}) }
                  : null,
              },
              {
                onSuccess: () => {
                  set({ arrivalPrivate: "" });
                  setSaved(true);
                },
              },
            )
          }
        >
          Save
        </button>
      </FormActions>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card glass stack">
      <SectionHead title={title} />
      {children}
    </section>
  );
}
