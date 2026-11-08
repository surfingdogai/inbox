import { Link, useNavigate } from "@tanstack/react-router";
import { Newspaper } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { problemOf } from "../lib/api";
import {
  DELETE_ALL_ASK,
  DELETE_ALL_LABEL,
  MOVED_TO_INBOX,
  NOTICES_SEEN_KEY,
  newNotices,
  noticesLine,
  readNoticesSeen,
} from "../lib/notices";
import { useCounts, useNoticeActions } from "../lib/queries";
import { useSpamActions } from "./SpamActions";

/**
 * A notice's acts, one press each: Move to inbox (a conversation from now on, still yours alone) and
 * Delete, which asks once more, since it cannot be undone. On the notice itself (`all`), also Delete all
 * from this sender: a flood cleared at once, asked once more too.
 */
export function NoticeActs({
  itemId,
  leaveOnDelete,
  all = false,
}: {
  itemId: string;
  leaveOnDelete?: boolean;
  all?: boolean;
}) {
  const { move, remove, removeAll } = useNoticeActions(itemId);
  const { tell } = useSpamActions();
  const navigate = useNavigate();
  const [asking, setAsking] = useState<"one" | "all" | null>(null);
  const busy = move.isPending || remove.isPending || removeAll.isPending;
  const error = move.error ?? remove.error ?? removeAll.error;
  const gone = () => {
    if (leaveOnDelete) void navigate({ to: "/", search: (prev) => prev });
  };
  return (
    <div className="screen-acts notice-acts">
      {asking ? (
        <>
          <span className="notice-ask">{asking === "all" ? DELETE_ALL_ASK : "Delete it for good?"}</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() =>
              asking === "all"
                ? removeAll.mutate(undefined, { onSuccess: gone })
                : remove.mutate(undefined, { onSuccess: gone })
            }
          >
            Delete
          </button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setAsking(null)}>
            Keep
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => move.mutate(undefined, { onSuccess: () => tell(MOVED_TO_INBOX, itemId) })}
          >
            Move to inbox
          </button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setAsking("one")}>
            Delete
          </button>
          {all && (
            <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setAsking("all")}>
              {DELETE_ALL_LABEL}
            </button>
          )}
        </>
      )}
      {error && (
        <span className="hint error" role="alert">
          {problemOf(error).detail}
        </span>
      )}
    </div>
  );
}

// ---- new notices, said quietly above the inbox -----------------------------------------------------

/** When this browser last opened Notices: read once, then kept here, so every line agrees at once. */
let seenAt: number | null | undefined;
const seenListeners = new Set<() => void>();

function seenSnapshot(): number | null {
  if (seenAt === undefined) {
    try {
      seenAt = readNoticesSeen(localStorage.getItem(NOTICES_SEEN_KEY));
    } catch {
      seenAt = null;
    }
  }
  return seenAt;
}

function onSeen(listener: () => void): () => void {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}

/** Notices opened now: those that came before are not new any more, on this browser. */
export function markNoticesSeen(at: number = Date.now()): void {
  seenAt = at;
  try {
    localStorage.setItem(NOTICES_SEEN_KEY, String(at));
  } catch {
    // A private window keeps it for this visit only.
  }
  for (const listener of seenListeners) listener();
}

/**
 * Above the inbox, quietly: how many notices came since you last opened Notices (on this browser; the
 * last week's before you ever did), and the way to them. Nothing when none did.
 */
export function NoticesLine({ sandbox }: { sandbox: boolean }) {
  const counts = useCounts(sandbox).data;
  const seen = useSyncExternalStore(onSeen, seenSnapshot, () => null);
  if (!counts) return null;
  const n = newNotices(counts.noticeTimes, seen);
  if (n === 0) return null;
  return (
    <p className="notices-line">
      <Newspaper className="icon-sm" aria-hidden="true" />
      <span>{noticesLine(n, counts.noticesMore && n === counts.noticeTimes.length)}</span>
      <span aria-hidden="true">·</span>
      <Link to="/" search={{ f: "notices" }} className="msg-link" aria-label="Open Notices">
        Open
      </Link>
    </p>
  );
}
