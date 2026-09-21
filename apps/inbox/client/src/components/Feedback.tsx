import clsx from "clsx";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Feedback that gives direction, not mood: a toast says what happened and what comes next, an
 * error state says what to do. The striped sun appears on sign-in and the empty inbox only.
 */
export function Toast({
  tone,
  text,
  sub,
  action,
  onDismiss,
}: {
  tone: "success" | "danger" | "neutral";
  text: string;
  sub?: string | undefined;
  action?: ReactNode;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <output className="toast glass-strong">
      <i className={clsx("dot", tone !== "neutral" && `dot-${tone}`)} />
      <div className="x">
        {text}
        {sub && <small>{sub}</small>}
      </div>
      {action}
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </output>
  );
}

export function ErrorState({
  title,
  text,
  onRetry,
  children,
}: {
  title: string;
  text: string;
  onRetry?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="state" role="alert">
      <h3>{title}</h3>
      <p>{text}</p>
      <div className="rowx center">
        {onRetry && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            <RefreshCw className="icon" aria-hidden="true" />
            Try again
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

const SKELETON_ROWS = ["a", "b", "c", "d"] as const;

export function SkeletonRows({ n = 3 }: { n?: number | undefined }) {
  return (
    <div className="stack" aria-busy="true">
      {SKELETON_ROWS.slice(0, n).map((k) => (
        <div className="row" key={k}>
          <i className="dot" />
          <div>
            <div className="skeleton sk-title" />
            <div className="skeleton sk-line" />
          </div>
          <div className="skeleton sk-meta" />
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="card glass" aria-busy="true">
      <div className="skeleton sk-title" />
      <div className="skeleton sk-line" />
      <div className="skeleton sk-line" />
    </div>
  );
}

export function Sun({ size }: { size?: "sm" | "lg" | undefined }) {
  return <div className={clsx("sun", size && `sun-${size}`)} aria-hidden="true" />;
}
