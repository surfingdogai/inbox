import { OfflineIcon } from "./icons";

/** The honest offline banner (the approved Inboxes screen): what is shown is as it was, and when. */
export function OfflineBanner({ since, queued }: { since: number; queued: number }) {
  const at = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(since),
  );
  return (
    <div className="banner" role="status">
      <OfflineIcon />
      <span>
        You're offline. This is how things were at {at}. Anything you do is sent when you're back
        {queued > 0 ? ` (${queued} waiting)` : ""}.
      </span>
    </div>
  );
}
