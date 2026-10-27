import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, problemOf } from "../lib/api";
import { followDone, type SpamAct, type ToastCopy, toastFor, UNDO_MS } from "../lib/spam";
import type { ItemView } from "../lib/types";

/**
 * Let it in, Not spam, Looks fine and Spam (ADR-029 §11.3): one press each, a toast saying what it did,
 * and Undo for six seconds. Nothing is sent until the six seconds are up, so Undo leaves no trace
 * anywhere: no list changed, nothing taught, no rule run. Another press, leaving the inbox or closing
 * the page sends what waits at once.
 */

interface Pending {
  readonly key: number;
  readonly view: ItemView;
  readonly act: SpamAct;
  readonly toast: ToastCopy;
}

interface SpamActions {
  /** Does an act, after the six seconds Undo has. */
  readonly act: (view: ItemView, act: SpamAct) => void;
  /** Items whose act waits: lists leave them out until it is sent or undone. */
  readonly hidden: ReadonlySet<string>;
}

const Ctx = createContext<SpamActions | null>(null);

export function useSpamActions(): SpamActions {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSpamActions outside SpamActionsProvider");
  return ctx;
}

/** Sends one act: the filter's own endpoints, or the item's transition where the act is one. */
function send(view: ItemView, act: SpamAct, keepalive: boolean): Promise<unknown> {
  const { item } = view;
  const screen = view.spam?.screen ?? null;
  const transition = (event: string) =>
    keepalive
      ? api.transitionKeepalive(item.id, { event, expected_version: item.version })
      : api.transition(item.id, { event, expected_version: item.version });
  switch (act) {
    case "let_in":
      return api.letIn(item.id, keepalive);
    case "looks_fine":
      return api.looksFine(item.id, keepalive);
    case "not_spam":
      // A message or a quote request has Not spam of its own; a held request a person sent to Spam is let in.
      return item.state === "spam" ? transition("unspam") : api.letIn(item.id, keepalive);
    case "spam":
      return screen === "held" || screen === "pending" ? api.markHeldSpam(item.id, keepalive) : transition("mark_spam");
  }
}

export function SpamActionsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "danger" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef<Pending | null>(null);
  const keys = useRef(0);

  const refresh = useCallback(
    (id: string) => {
      void qc.invalidateQueries({ queryKey: ["items"] });
      void qc.invalidateQueries({ queryKey: ["counts"] });
      void qc.invalidateQueries({ queryKey: ["item", id] });
      void qc.invalidateQueries({ queryKey: ["spam"] });
    },
    [qc],
  );

  /** Sends what waits now; the toast goes. */
  const commit = useCallback(
    async (p: Pending, keepalive = false): Promise<boolean> => {
      if (waiting.current?.key !== p.key) return true;
      waiting.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setPending((cur) => (cur?.key === p.key ? null : cur));
      try {
        await send(p.view, p.act, keepalive);
        return true;
      } catch (error) {
        setNotice({ tone: "danger", text: problemOf(error).detail });
        return false;
      } finally {
        refresh(p.view.item.id);
      }
    },
    [refresh],
  );

  const act = useCallback(
    (view: ItemView, kind: SpamAct) => {
      if (waiting.current) void commit(waiting.current);
      keys.current += 1;
      const p: Pending = { key: keys.current, view, act: kind, toast: toastFor(kind, view) };
      waiting.current = p;
      setNotice(null);
      setPending(p);
      timer.current = setTimeout(() => void commit(p), UNDO_MS);
    },
    [commit],
  );

  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    waiting.current = null;
    setPending(null);
  };

  /** The small choice under the toast: sends the act first, then does it. */
  const follow = async (p: Pending) => {
    const kind = p.toast.follow?.kind;
    if (!kind || !(await commit(p))) return;
    if (kind === "suggest_time") {
      void navigate({
        to: "/items/$id",
        params: { id: p.view.item.id },
        search: (prev) => ({ ...prev, do: "propose" }),
      });
      return;
    }
    try {
      if (kind === "let_domain" && p.view.spam?.sender.company_domain) {
        await api.letDomainThrough(p.view.spam.sender.company_domain, p.view.item.id);
      } else if (kind === "block") {
        await api.alwaysPutAside(p.view.item.id);
      }
      setNotice({ tone: "success", text: followDone(kind === "let_domain" ? "let_domain" : "block", p.view) });
    } catch (error) {
      setNotice({ tone: "danger", text: problemOf(error).detail });
    } finally {
      void qc.invalidateQueries({ queryKey: ["spam"] });
    }
  };

  // Leaving the page sends what waits, so an act is never lost to a closed tab; so does leaving the inbox.
  useEffect(() => {
    const leave = () => {
      if (waiting.current) void commit(waiting.current, true);
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [commit]);

  // A notice after the act is gone after a while; one with a problem stays until dismissed.
  useEffect(() => {
    if (!notice || notice.tone === "danger") return;
    const t = setTimeout(() => setNotice(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const hidden = useMemo(() => new Set(pending ? [pending.view.item.id] : []), [pending]);
  const value = useMemo(() => ({ act, hidden }), [act, hidden]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="spam-toasts" aria-live="polite">
        {pending && (
          <output className="toast glass-strong spam-toast">
            <i className="dot" />
            <div className="x">
              {pending.toast.text}
              {pending.toast.follow && (
                <button type="button" className="link-button" onClick={() => void follow(pending)}>
                  {pending.toast.follow.label}
                </button>
              )}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={undo}>
              Undo
            </button>
          </output>
        )}
        {!pending && notice && (
          <output className="toast glass-strong spam-toast">
            <i className={notice.tone === "danger" ? "dot dot-warning" : "dot"} />
            <div className="x">{notice.text}</div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </output>
        )}
      </div>
    </Ctx.Provider>
  );
}
