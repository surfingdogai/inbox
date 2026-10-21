import { OfflineIcon } from "./icons";

/**
 * The honest offline banner (the approved Inboxes screen): what is shown is as it was, and when; or,
 * when nothing of this inbox is on the phone yet, that too. Shown once, above every screen.
 */
export function OfflineBanner({ cachedAt, inbox, queued }: { cachedAt: number | null; inbox: string; queued: number }) {
  const waiting = queued > 0 ? ` (${queued} waiting)` : "";
  let text: string;
  if (cachedAt === null) {
    text = `You're offline. Nothing from ${inbox || "this inbox"} is saved on this phone yet.`;
  } else {
    const at = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      new Date(cachedAt),
    );
    text = `You're offline. This is how things were at ${at}. Anything you do is sent when you're back${waiting}.`;
  }
  return (
    <div className="banner" role="status">
      <OfflineIcon />
      <span>{text}</span>
    </div>
  );
}

/** Where a list would be, while the inbox cannot be reached and nothing of it is on the phone. */
export function CannotReach({ inbox }: { inbox: string }) {
  return (
    <div className="empty">
      <b>Can't reach {inbox || "your inbox"}</b>
      It shows here when you're back online.
    </div>
  );
}
