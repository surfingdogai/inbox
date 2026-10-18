import type { JobHandler } from "../jobs/runner";
import type { ConnectorCapabilities } from "./capability";

/**
 * The two jobs a connection runs. A sync (every five minutes, and when the owner asks) writes
 * bookings out and reads busy times; a push (after every booking event) only writes bookings out.
 * A sync queues its successor before it calls the platform, so a platform that is down today is
 * read again in five minutes rather than never. A connection that is gone or paused ends its chain;
 * connecting or unpausing starts it again.
 */
export function connectorSyncHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { now }) => {
    const id = (job.payload as { connectorId?: unknown } | null)?.connectorId;
    if (typeof id !== "string") return { note: "no connection id" };
    if (!(await connectors.active(id))) return { note: `connection ${id} is gone or paused` };
    await connectors.scheduleNext(id, now);
    const report = await connectors.run(id, now, "sync");
    return { note: report ? `connection ${id}: ${report.note}` : `connection ${id} is gone` };
  };
}

export function connectorPushHandler(connectors: ConnectorCapabilities): JobHandler {
  return async (job, { now }) => {
    const id = (job.payload as { connectorId?: unknown } | null)?.connectorId;
    if (typeof id !== "string") return { note: "no connection id" };
    const report = await connectors.run(id, now, "push");
    return { note: report ? `connection ${id}: ${report.note}` : `connection ${id} is gone` };
  };
}
