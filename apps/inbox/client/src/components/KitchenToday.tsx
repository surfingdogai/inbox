import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { Pause, Play } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api, problemOf } from "../lib/api";
import {
  METHOD_WORDS,
  nextStages,
  ordersForToday,
  pauseLine,
  STAGE_WORDS,
  useKitchenNow,
  usePause,
  useProgress,
} from "../lib/food";
import { formatClock, partyName } from "../lib/format";
import { StatePill } from "./Pills";

/**
 * The kitchen on the inbox's home (ADR-036): whether orders are coming in, the pause (15, 30, 60
 * minutes or the rest of the day, any person at the business), and today's orders for a time, earliest
 * first, each with the next press for the kitchen: Preparing, Ready, Out for delivery.
 */
export function KitchenToday({ tz, sandbox }: { tz: string | undefined; sandbox: boolean }) {
  const now = useKitchenNow();
  return now.data?.enabled ? <Kitchen tz={tz} sandbox={sandbox} paused_until={now.data.paused_until} /> : null;
}

/** On a phone, where the list is the home: the pause alone, above the conversations. */
export function KitchenStrip({ tz }: { tz: string | undefined }) {
  const now = useKitchenNow();
  if (!now.data?.enabled) return null;
  return (
    <div className="kitchen-strip">
      <PauseControl tz={tz} paused_until={now.data.paused_until}>
        <span className="label">Kitchen</span>
      </PauseControl>
    </div>
  );
}

/** Whether orders come in, and the press that pauses them (any person at the business) or resumes them. */
function PauseControl({
  tz,
  paused_until,
  children,
}: {
  tz: string | undefined;
  paused_until: string | null;
  children: ReactNode;
}) {
  const pause = usePause();
  const [choosing, setChoosing] = useState(false);
  const paused = pauseLine(paused_until, tz, Date.now());
  const press = (body: Parameters<typeof pause.mutate>[0]) =>
    pause.mutate(body, { onSuccess: () => setChoosing(false) });
  return (
    <>
      <div className="sec-head">
        {children}
        <div className="kitchen-pause">
          {paused ? (
            <>
              <span className="pill tint-warning" role="status">
                <Pause className="icon-xs" aria-hidden="true" />
                {paused}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={pause.isPending}
                onClick={() => press({ resume: true })}
              >
                <Play className="icon-xs" aria-hidden="true" />
                Resume
              </button>
            </>
          ) : (
            <>
              <span className="pill tint-success" role="status">
                <i className="dot" />
                Taking orders
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={choosing}
                onClick={() => setChoosing(!choosing)}
              >
                <Pause className="icon-xs" aria-hidden="true" />
                Pause
              </button>
            </>
          )}
        </div>
      </div>
      {choosing && !paused && (
        <fieldset className="chips kitchen-pause-chips">
          <legend className="sr-only">Pause orders for</legend>
          {([15, 30, 60] as const).map((m) => (
            <button
              key={m}
              type="button"
              className="chip"
              disabled={pause.isPending}
              onClick={() => press({ minutes: m })}
            >
              {m === 60 ? "1 h" : `${m} min`}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            disabled={pause.isPending}
            onClick={() => press({ rest_of_day: true })}
          >
            Rest of today
          </button>
        </fieldset>
      )}
      {paused && <p className="hint">Agents are told when you take orders again.</p>}
      {pause.error && <p className="hint error">{problemOf(pause.error).detail}</p>}
    </>
  );
}

function Kitchen({
  tz,
  sandbox,
  paused_until,
}: {
  tz: string | undefined;
  sandbox: boolean;
  paused_until: string | null;
}) {
  const progress = useProgress();
  const orders = useQuery({
    queryKey: ["today", "orders", sandbox],
    queryFn: () => api.listItems({ type: "order", open_only: true, sandbox, limit: 100 }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const at = Date.now();
  const todays = ordersForToday(orders.data?.items ?? [], tz, at);

  return (
    <section className="card glass stack kitchen-today" aria-labelledby="kitchen-today">
      <PauseControl tz={tz} paused_until={paused_until}>
        <h3 className="sec" id="kitchen-today">
          Kitchen
        </h3>
      </PauseControl>
      {orders.isSuccess && todays.length === 0 && <p className="hint">No orders for later today.</p>}
      {todays.length > 0 && (
        <ul className="today-list kitchen-list">
          {todays.map((v) => {
            if (v.item.type !== "order") return null;
            const p = v.item.payload;
            const stages = nextStages(v.item.state, p.progress, p.fulfil?.method);
            const last = stages[stages.length - 1];
            const count = p.orderedItem.reduce((n, l) => n + l.quantity, 0);
            return (
              <li key={v.item.id} className="kitchen-line">
                <Link to="/items/$id" params={{ id: v.item.id }} search={(prev) => prev} className="today-line">
                  <span className="when">{p.fulfil?.slot ? formatClock(p.fulfil.slot.start, tz) : ""}</span>
                  <span className="what">
                    <b>{partyName(v.party)}</b>{" "}
                    <span>
                      {count} {count === 1 ? "item" : "items"} · {METHOD_WORDS[p.fulfil?.method ?? ""] ?? ""}
                      {p.progress ? ` · ${STAGE_WORDS[p.progress.stage]}` : ""}
                    </span>
                  </span>
                  <StatePill state={v.item.state} small />
                </Link>
                {last && (
                  <button
                    type="button"
                    className={clsx("btn btn-sm", last === "ready" ? "btn-primary" : "btn-secondary")}
                    disabled={progress.isPending}
                    onClick={() => progress.mutate({ itemId: v.item.id, stage: last })}
                  >
                    {STAGE_WORDS[last]}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {progress.error && <p className="hint error">{problemOf(progress.error).detail}</p>}
    </section>
  );
}
