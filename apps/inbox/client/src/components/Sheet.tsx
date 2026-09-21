import { type ReactNode, useEffect, useRef } from "react";

/**
 * A bottom sheet for phones on the native <dialog>: modal, focus kept inside, Esc and a tap on the
 * backdrop close it. One confirmation at a time, on strong glass, inside the safe area.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    el.addEventListener("cancel", onCancel);
    return () => {
      el.removeEventListener("cancel", onCancel);
      if (el.open) el.close();
    };
  }, []);

  return (
    <dialog ref={ref} className="sheet-dialog" aria-labelledby="sheet-title">
      <button type="button" className="sheet-backdrop" aria-label="Close" onClick={onClose} />
      <div className="sheet glass-strong">
        <h3 id="sheet-title" className="sheet-title">
          {title}
        </h3>
        {children}
      </div>
    </dialog>
  );
}
