import type { ReactNode } from "react";

/** A labelled field with its hint, or the API's sentence about it when there is one. */
export function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  optional?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
        {optional && <span className="opt"> · optional</span>}
      </label>
      {children}
      {error ? (
        <div className="hint error" role="alert">
          {error}
        </div>
      ) : (
        hint && <div className="hint">{hint}</div>
      )}
    </div>
  );
}

/**
 * An on/off switch with its line. `pending`: switched on, but waiting for something it needs (a
 * service, opening hours); the track shows it, and `describedBy` names the reason for a screen reader.
 */
export function Switch({
  checked,
  onChange,
  children,
  disabled,
  pending,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  disabled?: boolean | undefined;
  pending?: boolean | undefined;
  describedBy?: string | undefined;
}) {
  return (
    <label className={pending ? "check is-pending" : "check"}>
      <span className={pending ? "switch is-pending" : "switch"}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span />
      </span>
      {children}
    </label>
  );
}

/** A form's buttons, the main one last, on the right, as everywhere in Settings. */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}

/** A card's title row with its action on the right. */
export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="sec-head">
      <h3 className="sec">{title}</h3>
      {children}
    </div>
  );
}
