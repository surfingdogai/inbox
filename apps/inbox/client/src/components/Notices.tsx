import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { problemOf } from "../lib/api";
import { DELETE_ALL_ASK, DELETE_ALL_LABEL } from "../lib/notices";
import { useNoticeActions } from "../lib/queries";

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
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => move.mutate()}>
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
