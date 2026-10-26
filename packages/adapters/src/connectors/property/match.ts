/**
 * Which room of a stay each room a property system already holds for it is (ADR-037 §8.4). A system
 * gives a stay's rooms back in its own order — Cloudbeds lists the assigned ones first, Mews a group in
 * no documented order — so position says nothing: each room it holds is paired with one of the stay's by
 * its room type and its people first, then by its room type, then with what is left. A stay whose rooms
 * all pair exactly is the same stay, and is not written again.
 */

export interface RoomShape {
  readonly type: string;
  /** Who stays in it, as one comparable string: adults and children (or each age category's count). */
  readonly people: string;
}

export interface RoomMatch {
  /** For each room the system holds, in its order: the index of the stay's room it is. */
  readonly pairs: readonly number[];
  /** Whether every room pairs with one of the same type and the same people. */
  readonly same: boolean;
}

/** Pairs `held` with `wanted`, the same number of each; see the module's note. */
export function matchRooms(held: readonly RoomShape[], wanted: readonly RoomShape[]): RoomMatch {
  const pairs: number[] = held.map(() => -1);
  const taken = new Set<number>();
  const pass = (fits: (h: RoomShape, w: RoomShape) => boolean) => {
    held.forEach((h, i) => {
      if (pairs[i] !== -1) return;
      const j = wanted.findIndex((w, k) => !taken.has(k) && fits(h, w));
      if (j === -1) return;
      pairs[i] = j;
      taken.add(j);
    });
  };
  pass((h, w) => h.type === w.type && h.people === w.people);
  const exact = pairs.every((p) => p !== -1) && held.length === wanted.length;
  pass((h, w) => h.type === w.type);
  pass(() => true);
  return { pairs, same: exact };
}
