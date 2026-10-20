import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { problemOf } from "../lib/api";
import {
  addDays,
  allotmentReady,
  cellOf,
  EVERY_DAY,
  type PropertyView,
  propertyApi,
  useNights,
  usePropertyWrite,
} from "../lib/property";
import { Stepper } from "./Choosers";
import { Field, FormActions, SectionHead } from "./Form";
import { WeekdayChips } from "./Property";
import { Sheet } from "./Sheet";

const DAYS = 14;

function dayLabel(date: string): { wd: string; d: string } {
  const at = new Date(`${date}T12:00:00Z`);
  return {
    wd: new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(at),
    d: String(at.getUTCDate()),
  };
}

/**
 * The Nights grid (S10): each room type by the next two weeks — stays, holds with their minutes,
 * rooms kept for direct guests, another calendar's hint, closed nights. Keeping rooms for direct
 * guests is a sheet that saves only once the owner says they are closed on every other channel.
 */
export function NightsCard({ setup }: { setup: PropertyView }) {
  const [from, setFrom] = useState<string | undefined>(undefined);
  const grid = useNights(from, DAYS);
  const [sheet, setSheet] = useState<"keep" | "close" | null>(null);
  const days = grid.data?.days ?? [];
  const first = days[0];
  return (
    <section className="card glass stack">
      <SectionHead title="Nights">
        <span className="sp" />
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          aria-label="Two weeks earlier"
          disabled={!first || from === undefined}
          onClick={() => first && setFrom(addDays(first, -DAYS))}
        >
          <ChevronLeft className="icon-sm" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          aria-label="Two weeks later"
          disabled={!first}
          onClick={() => first && setFrom(addDays(first, DAYS))}
        >
          <ChevronRight className="icon-sm" aria-hidden="true" />
        </button>
      </SectionHead>
      {grid.isPending && <div className="skeleton sk-line" />}
      {grid.isError && <p className="hint error">{problemOf(grid.error).detail}</p>}
      {grid.data && grid.data.rooms.length === 0 && <p className="hint">Add your rooms first.</p>}
      {grid.data && grid.data.rooms.length > 0 && (
        <div className="nights-scroll">
          <table className="nights">
            <thead>
              <tr>
                <th scope="col" className="nights-room">
                  <span className="sr-only">Room</span>
                </th>
                {days.map((day) => {
                  const l = dayLabel(day);
                  return (
                    <th key={day} scope="col">
                      <span className="nights-wd">{l.wd}</span>
                      <span className="nights-d">{l.d}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {grid.data.rooms.map((room) => (
                <tr key={room.id}>
                  <th scope="row" className="nights-room">
                    {room.name}
                    <span className="nights-units">{room.units}</span>
                  </th>
                  {room.cells.map((cell) => {
                    const c = cellOf(cell, room.units);
                    const stay = cell.stays[0] ?? cell.holds[0];
                    const mark = c.tone === "closed" ? "×" : cell.kept ? String(cell.kept) : "";
                    return (
                      <td
                        key={cell.night}
                        className={`night is-${c.tone}${cell.hint ? " has-hint" : ""}`}
                        title={c.words}
                      >
                        {stay ? (
                          <Link to="/items/$id" params={{ id: stay.item_id }} aria-label={`${cell.night}: ${c.words}`}>
                            {mark}
                          </Link>
                        ) : (
                          <span>
                            {mark}
                            <span className="sr-only">
                              {cell.night}: {c.words}
                            </span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint nights-key">
        <i className="night-dot is-full" /> booked <i className="night-dot is-held" /> held{" "}
        <i className="night-dot has-hint" /> another calendar shows it taken · a number: rooms kept for direct guests ·
        × closed
      </p>
      <FormActions>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSheet("close")}>
          Close nights
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSheet("keep")}>
          Keep rooms for direct guests
        </button>
      </FormActions>
      {sheet === "keep" && <KeepSheet setup={setup} onClose={() => setSheet(null)} />}
      {sheet === "close" && <CloseSheet setup={setup} onClose={() => setSheet(null)} />}
    </section>
  );
}

function KeepSheet({ setup, onClose }: { setup: PropertyView; onClose: () => void }) {
  const rooms = setup.rooms.filter((r) => r.active);
  const [d, setD] = useState({
    room: rooms[0]?.id ?? "",
    from: "",
    to: "",
    weekdays: EVERY_DAY,
    units: "1",
    closedElsewhere: false,
  });
  const room = rooms.find((r) => r.id === d.room);
  const save = usePropertyWrite(propertyApi.allotment);
  const problem = allotmentReady({
    units: Number(d.units),
    from: d.from,
    to: d.to,
    closedElsewhere: d.closedElsewhere,
  });
  return (
    <Sheet title="Keep rooms for direct guests" onClose={onClose}>
      <div className="stack">
        <p className="lede small">
          Inside these nights, a guest's assistant books one of these rooms at once. Close them on your other channels
          first, so nobody else can take them.
        </p>
        <Field id="k-room" label="Room">
          <select id="k-room" className="input" value={d.room} onChange={(e) => setD({ ...d, room: e.target.value })}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Stepper
          id="k-units"
          label="How many"
          value={d.units}
          onChange={(units) => setD({ ...d, units })}
          min={0}
          max={room?.units ?? 1}
          hint="0 stops keeping them."
        />
        <div className="grid2">
          <Field id="k-from" label="First night">
            <input
              id="k-from"
              className="input"
              type="date"
              value={d.from}
              onChange={(e) => setD({ ...d, from: e.target.value })}
            />
          </Field>
          <Field id="k-to" label="Last night">
            <input
              id="k-to"
              className="input"
              type="date"
              min={d.from}
              value={d.to}
              onChange={(e) => setD({ ...d, to: e.target.value })}
            />
          </Field>
        </div>
        <WeekdayChips value={d.weekdays} onChange={(weekdays) => setD({ ...d, weekdays })} />
        <label className="check">
          <input
            type="checkbox"
            checked={d.closedElsewhere}
            onChange={(e) => setD({ ...d, closedElsewhere: e.target.checked })}
          />
          These rooms are closed on my other channels for these nights
        </label>
        {problem && d.closedElsewhere && <p className="hint">{problem}</p>}
        {save.isError && <p className="hint error">{problemOf(save.error).detail}</p>}
        <FormActions>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={problem !== null || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  room_type_id: d.room,
                  from_date: d.from,
                  to_date: d.to,
                  weekdays: d.weekdays,
                  units: Number(d.units),
                  closed_elsewhere: true,
                },
                { onSuccess: onClose },
              )
            }
          >
            Keep them
          </button>
        </FormActions>
      </div>
    </Sheet>
  );
}

function CloseSheet({ setup, onClose }: { setup: PropertyView; onClose: () => void }) {
  const rooms = setup.rooms.filter((r) => r.active);
  const [d, setD] = useState({ room: "", from: "", to: "", note: "", reopen: false });
  const save = usePropertyWrite(propertyApi.closure);
  return (
    <Sheet title={d.reopen ? "Open nights again" : "Close nights"} onClose={onClose}>
      <div className="stack">
        <Field id="c-room" label="Room">
          <select id="c-room" className="input" value={d.room} onChange={(e) => setD({ ...d, room: e.target.value })}>
            <option value="">The whole property</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid2">
          <Field id="c-from" label="First night">
            <input
              id="c-from"
              className="input"
              type="date"
              value={d.from}
              onChange={(e) => setD({ ...d, from: e.target.value })}
            />
          </Field>
          <Field id="c-to" label="Last night">
            <input
              id="c-to"
              className="input"
              type="date"
              min={d.from}
              value={d.to}
              onChange={(e) => setD({ ...d, to: e.target.value })}
            />
          </Field>
        </div>
        {!d.reopen && (
          <Field id="c-note" label="Why" optional hint="For you only.">
            <input
              id="c-note"
              className="input"
              value={d.note}
              onChange={(e) => setD({ ...d, note: e.target.value })}
            />
          </Field>
        )}
        <label className="check">
          <input type="checkbox" checked={d.reopen} onChange={(e) => setD({ ...d, reopen: e.target.checked })} />
          Open these nights again instead
        </label>
        {save.isError && <p className="hint error">{problemOf(save.error).detail}</p>}
        <FormActions>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!d.from || !d.to || d.to < d.from || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  property_id: setup.property.id,
                  ...(d.room ? { room_type_id: d.room } : {}),
                  from_date: d.from,
                  to_date: d.to,
                  ...(d.note.trim() && !d.reopen ? { note: d.note.trim() } : {}),
                  ...(d.reopen ? { reopen: true } : {}),
                },
                { onSuccess: onClose },
              )
            }
          >
            {d.reopen ? "Open them" : "Close them"}
          </button>
        </FormActions>
      </div>
    </Sheet>
  );
}
