/**
 * One press waiting for Undo (ADR-029 §12): Let it in, Not spam or Spam is sent when its six seconds
 * end, when it is sent now (the item closes, the app goes to the background, another press takes its
 * place), or never, when Undo is pressed. Nothing else sends it: a screen drawing itself again, a
 * refresh, a toast, the network coming back.
 */
export class Waiting<A> {
  private current: { readonly act: A; readonly timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly send: (act: A) => void | Promise<void>,
    private readonly ms: number,
    /** Told when nothing waits any more: sent, or undone. */
    private readonly onDone: () => void = () => undefined,
  ) {}

  /** The press that waits, if one does. */
  get pending(): A | null {
    return this.current?.act ?? null;
  }

  /** A press: one already waiting is sent first, and this one waits its six seconds. */
  start(act: A): void {
    this.now();
    this.current = { act, timer: setTimeout(() => this.now(), this.ms) };
  }

  /** Undo: what waits is dropped, and nothing is sent. */
  undo(): void {
    const w = this.current;
    if (!w) return;
    clearTimeout(w.timer);
    this.current = null;
    this.onDone();
  }

  /** Sends what waits at once, if anything does. */
  now(): void {
    const w = this.current;
    if (!w) return;
    clearTimeout(w.timer);
    this.current = null;
    this.onDone();
    void this.send(w.act);
  }
}
