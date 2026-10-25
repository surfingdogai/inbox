/**
 * The spam filter page's drawing (SpamFlow.astro), as numbers: where each envelope is at any moment
 * of the loop. Stateless — every position and opacity is a function of the loop time — so the
 * server's still picture, a resumed clock and the reduced-motion frame can never disagree.
 *
 * Five envelopes come in from three doors (email, the website, AI agents). Two customers land on
 * the desk as rows. A sales pitch and a scam settle softly into the tray below, where what is put
 * aside waits. The fifth, not quite sure, settles there too; a tap lifts it back up to the desk.
 * Then the picture holds, and the loop starts again.
 */

export const VIEW = { w: 640, h: 300 } as const;
/** One pass, in seconds. */
export const LOOP = 11;
/** The composed still frame: every envelope where it ends. */
export const REST = 9.4;

export const DOORS = [
  { id: "email", label: "EMAIL", y: 70 },
  { id: "site", label: "WEBSITE", y: 150 },
  { id: "agents", label: "AI AGENTS", y: 230 },
] as const;

export const NODE_X = 118;
/** Where every envelope passes into the inbox. */
export const GATE = { x: 362, y: 116 } as const;
export const DESK = { x: 380, y: 34, w: 236, h: 150 } as const;
export const TRAY = { x: 380, y: 206, w: 236, h: 70 } as const;
export const ROWS = [72, 108, 144] as const;
export const SLOTS = [418, 482, 546] as const;
export const SLOT_Y = 244;

export type Kind = "customer" | "pitch" | "unsure";

export interface Piece {
  readonly id: string;
  readonly kind: Kind;
  readonly door: number;
  /** When it leaves its door. */
  readonly at: number;
  /** Where it ends: a row on the desk, or a slot in the tray. */
  readonly to: { readonly row: number } | { readonly slot: number };
  /** Lifted back from the tray to this row, at this time (the tap). */
  readonly lift?: { readonly at: number; readonly row: number };
}

export const PIECES: readonly Piece[] = [
  { id: "a", kind: "customer", door: 0, at: 0.2, to: { row: 0 } },
  { id: "b", kind: "pitch", door: 1, at: 1.0, to: { slot: 0 } },
  { id: "c", kind: "customer", door: 2, at: 1.9, to: { row: 1 } },
  { id: "d", kind: "pitch", door: 0, at: 2.8, to: { slot: 1 } },
  { id: "e", kind: "unsure", door: 1, at: 3.7, to: { slot: 2 }, lift: { at: 6.7, row: 2 } },
];

const IN = 1.1;
const DOWN = 0.9;
const LIFT = 1.1;
const LAND = 0.3;
/** When the tap shows, before the lift. */
export const TAP = { at: 6.1, dur: 0.6 } as const;
/** The whole picture fades before the loop starts again. */
const FADE = { from: 10.2, to: 10.8 } as const;

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const soft = (t: number) => 1 - (1 - t) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const quad = (a: number, c: number, b: number, t: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;

export interface Pose {
  /** The envelope's centre. */
  readonly x: number;
  readonly y: number;
  /** The envelope's own opacity: it fades into a row when it lands on the desk. */
  readonly o: number;
  /** The row it became, on the desk: 0 to 1. */
  readonly row: number;
  /** Which row that is, when it has one. */
  readonly rowY: number | null;
}

/** Where one envelope is at loop time t. */
export function pose(p: Piece, t: number): Pose {
  const door = DOORS[p.door] ?? DOORS[0];
  const start = { x: NODE_X, y: door.y };
  const fade = 1 - clamp((t - FADE.from) / (FADE.to - FADE.from));
  if (t < p.at) return { ...start, o: 0, row: 0, rowY: null };
  const k = clamp((t - p.at) / IN);
  if (k < 1) {
    const e = ease(k);
    return {
      x: quad(start.x, (start.x + GATE.x) / 2, GATE.x, e),
      y: quad(start.y, start.y, GATE.y, e),
      o: clamp(k * 4) * fade,
      row: 0,
      rowY: null,
    };
  }
  const arrived = p.at + IN;
  const toRow = (row: number, from: { x: number; y: number }, since: number, dur: number): Pose => {
    const y = ROWS[row] ?? ROWS[0];
    const m = clamp((t - since) / dur);
    const e = soft(m);
    const x = lerp(from.x, DESK.x + 26, e);
    const yy = quad(from.y, from.y < y ? from.y : y - 30, y, e);
    const landed = clamp((t - since - dur) / LAND);
    return { x, y: yy, o: (1 - landed) * fade, row: landed * fade, rowY: y };
  };
  if ("row" in p.to) return toRow(p.to.row, GATE, arrived, DOWN);
  const slot = { x: SLOTS[p.to.slot] ?? SLOTS[0], y: SLOT_Y };
  if (p.lift && t >= p.lift.at) return toRow(p.lift.row, slot, p.lift.at, LIFT);
  const m = soft(clamp((t - arrived) / DOWN));
  return {
    x: lerp(GATE.x, slot.x, m),
    y: quad(GATE.y, GATE.y + 60, slot.y, m),
    o: fade,
    row: 0,
    rowY: null,
  };
}

/** The tap that lifts the unsure one back: a ring that grows and fades. */
export function tap(t: number): { readonly r: number; readonly o: number } {
  const k = (t - TAP.at) / TAP.dur;
  if (k < 0 || k > 1) return { r: 0, o: 0 };
  return { r: 6 + 12 * soft(k), o: 1 - k };
}

/** Whether the tray's caption shows: once something has settled there. */
export function trayCaption(t: number): number {
  const first = PIECES.find((p) => "slot" in p.to);
  if (!first) return 0;
  const fade = 1 - clamp((t - FADE.from) / (FADE.to - FADE.from));
  return clamp((t - first.at - IN - DOWN) / 0.4) * fade;
}
