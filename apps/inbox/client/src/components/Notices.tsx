import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { problemOf } from "../lib/api";
import { useNoticeActions } from "../lib/queries";

/**
 * A notice's two acts, one press each: Move to inbox (a conversation from now on, still yours alone)
 * and Delete, which asks once more, since it cannot be undone.
 */
export function NoticeActs({ itemId, leaveOnDelete }: { itemId: string; leaveOnDelete?: boolean }) {
  const { move, remove } = useNoticeActions(itemId);
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const busy = move.isPending || remove.isPending;
  const error = move.error ?? remove.error;
  const gone = () => {
    if (leaveOnDelete) void navigate({ to: "/", search: (prev) => prev });
  };
  return (
    <div className="screen-acts notice-acts">
      {asking ? (
        <>
          <span className="notice-ask">Delete it for good?</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => remove.mutate(undefined, { onSuccess: gone })}
          >
            Delete
          </button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setAsking(false)}>
            Keep
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => move.mutate()}>
            Move to inbox
          </button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setAsking(true)}>
            Delete
          </button>
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
