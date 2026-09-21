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

export function Switch({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  disabled?: boolean | undefined;
}) {
  return (
    <label className="check">
      <span className="switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      {children}
    </label>
  );
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
