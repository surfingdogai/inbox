import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SourceTag, TimeZoneSelect } from "../components/Choosers";
import { ErrorState, Toast } from "../components/Feedback";
import { ClosuresEditor, HoursEditor } from "../components/Hours";
import { problemOf } from "../lib/api";
import { describeWeekly } from "../lib/hours";
import {
  useAvailability,
  useClearOverride,
  useSaveClosures,
  useSaveProfile,
  useSaveSettings,
  useSaveWeekly,
  useServices,
  useSettings,
} from "../lib/queries";
import { clearSources, sourceNote } from "../lib/sources";

export const Route = createFileRoute("/settings/availability")({
  component: AvailabilityPage,
});

/** When the business takes bookings: its time zone, the weekly hours, a service's own hours, and closed days. */
function AvailabilityPage() {
  const availability = useAvailability();
  const services = useServices();
  const settings = useSettings();
  const saveWeekly = useSaveWeekly();
  const saveProfile = useSaveProfile();
  const saveSettings = useSaveSettings();
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
  const unset = !scope && !a.weekly_set;
  const editorKey = `${scope}:${unset}:${JSON.stringify(weekly)}`;
  const sources = settings.data?.doc.setup.sources;
  const hoursNote = scope ? null : sourceNote(sources, "hours");

  return (
    <>
      {notice && <Toast tone="success" text={notice} onDismiss={() => setNotice(null)} />}
      <section className="card glass stack">
        <div className="settings-grid hours-head">
          <div>
            <label className="label" htmlFor="hours-tz">
              Time zone
            </label>
            <TimeZoneSelect
              id="hours-tz"
              value={a.timezone}
              disabled={saveProfile.isPending}
              onChange={(timezone) =>
                saveProfile.mutate({ timezone }, { onSuccess: () => setNotice("Time zone saved.") })
              }
            />
            {saveProfile.error ? (
              <div className="hint error" role="alert">
                {problemOf(saveProfile.error).detail}
              </div>
            ) : (
              <div className="hint">Every time below is in it.</div>
            )}
          </div>
          {active.length > 0 && (
            <div>
              <label className="label" htmlFor="hours-scope">
                Hours for
              </label>
              <select id="hours-scope" className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">The whole business</option>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {a.overrides.some((o) => o.service_id === s.id) ? " · own hours" : ""}
                  </option>
                ))}
              </select>
              {service && override && (
                <button
                  type="button"
                  className="linkish"
                  disabled={clearOverride.isPending}
                  onClick={() =>
                    clearOverride.mutate(service.id, {
                      onSuccess: () => setNotice(`${service.name} follows the business hours again.`),
                    })
                  }
                >
                  Follow the business hours again
                </button>
              )}
            </div>
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
          unset={unset}
          note={<SourceTag source={hoursNote} />}
          title={service ? service.name : "Opening hours"}
          hint={
            service
              ? override
                ? `${service.name} has its own hours. Days left closed are closed for it.`
                : `Follows the business hours (${describeWeekly(a.weekly)}). Save to give it its own.`
              : "Days left closed take no bookings."
          }
          pending={saveWeekly.isPending}
          error={saveWeekly.error ? problemOf(saveWeekly.error) : null}
          onSave={(next) =>
            saveWeekly.mutate(
              { weekly: next, ...(scope ? { serviceId: scope } : {}) },
              {
                onSuccess: () => {
                  setNotice(service ? `Hours saved for ${service.name}.` : "Opening hours saved.");
                  // Saved by the owner: they have checked what was read.
                  const cleared = scope ? null : clearSources(sources, "hours");
                  if (cleared) saveSettings.mutate({ doc: cleared });
                },
              },
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
