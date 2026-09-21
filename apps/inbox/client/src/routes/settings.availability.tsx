import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorState, Toast } from "../components/Feedback";
import { ClosuresEditor, HoursEditor } from "../components/Hours";
import { problemOf } from "../lib/api";
import { describeWeekly } from "../lib/hours";
import { useAvailability, useClearOverride, useSaveClosures, useSaveWeekly, useServices } from "../lib/queries";

export const Route = createFileRoute("/settings/availability")({
  component: AvailabilityPage,
});

/** When the business takes bookings: the weekly hours, a service's own hours, and closed days. */
function AvailabilityPage() {
  const availability = useAvailability();
  const services = useServices();
  const saveWeekly = useSaveWeekly();
  const clearOverride = useClearOverride();
  const saveClosures = useSaveClosures();
  const [scope, setScope] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  if (availability.isPending) {
    return (
      <div className="card glass" aria-busy="true">
        <div className="skeleton sk-title" />
        <div className="skeleton sk-line" />
      </div>
    );
  }
  if (availability.isError) {
    return (
      <div className="card glass">
        <ErrorState
          title="Could not load the opening hours"
          text={problemOf(availability.error).detail}
          onRetry={() => void availability.refetch()}
        />
      </div>
    );
  }
  const a = availability.data;
  const active = (services.data?.items ?? []).filter((s) => s.active === 1);
  const override = a.overrides.find((o) => o.service_id === scope);
  const service = active.find((s) => s.id === scope);
  const weekly = scope ? (override?.weekly ?? a.weekly) : a.weekly;
  const editorKey = `${scope}:${JSON.stringify(weekly)}`;

  return (
    <>
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      <section className="card glass stack">
        <div className="rowx">
          <label className="label" htmlFor="hours-scope" style={{ margin: 0 }}>
            Hours for
          </label>
          <select
            id="hours-scope"
            className="input scope-select"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">The whole business</option>
            {active.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {a.overrides.some((o) => o.service_id === s.id) ? " · own hours" : ""}
              </option>
            ))}
          </select>
          <span className="hint">Time zone {a.timezone}; change it under General.</span>
          {service && override && (
            <>
              <span className="sp" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={clearOverride.isPending}
                onClick={() =>
                  clearOverride.mutate(service.id, {
                    onSuccess: () => setNotice(`${service.name} follows the business hours again.`),
                  })
                }
              >
                {clearOverride.isPending && <span className="spinner" aria-hidden="true" />}
                Follow business hours again
              </button>
            </>
          )}
        </div>
        {clearOverride.error && (
          <p className="hint error" role="alert">
            {problemOf(clearOverride.error).detail}
          </p>
        )}
        <HoursEditor
          key={editorKey}
          initial={weekly}
          title={service ? `${service.name}` : "Opening hours"}
          hint={
            service
              ? override
                ? `${service.name} has its own hours. Days you leave closed here are closed for it.`
                : `${service.name} follows the business hours (${describeWeekly(a.weekly)}). Save to give it its own.`
              : "Days you leave closed take no bookings. Up to six windows a day, for a lunch break or an evening."
          }
          pending={saveWeekly.isPending}
          error={saveWeekly.error ? problemOf(saveWeekly.error) : null}
          onSave={(next) =>
            saveWeekly.mutate(
              { weekly: next, ...(scope ? { serviceId: scope } : {}) },
              { onSuccess: () => setNotice(service ? `Hours saved for ${service.name}.` : "Opening hours saved.") },
            )
          }
        />
      </section>
      <section className="card glass">
        <ClosuresEditor
          key={JSON.stringify(a.closures)}
          initial={a.closures}
          pending={saveClosures.isPending}
          error={saveClosures.error ? problemOf(saveClosures.error) : null}
          onSave={(closures) => saveClosures.mutate(closures, { onSuccess: () => setNotice("Closed days saved.") })}
        />
      </section>
    </>
  );
}
