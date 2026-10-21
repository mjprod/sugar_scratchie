/**
 * Fixed-capacity scratch-mark ring (Phase 7).
 * Avoids `[...marks, next].slice(-N)` allocations on every stamp.
 */

export type ScratchMark = {
  u: number;
  v: number;
  radius: number;
};

export const SCRATCH_MARKS_CAPACITY = 180;

export type ScratchMarksRing = {
  readonly capacity: number;
  readonly slots: ScratchMark[];
  length: number;
  /** Index of the oldest live mark when length === capacity. */
  start: number;
};

export function createScratchMarksRing(
  capacity = SCRATCH_MARKS_CAPACITY,
): ScratchMarksRing {
  const slots: ScratchMark[] = [];
  for (let i = 0; i < capacity; i += 1) {
    slots.push({ u: 0, v: 0, radius: 0 });
  }
  return { capacity, slots, length: 0, start: 0 };
}

export function clearScratchMarks(ring: ScratchMarksRing): void {
  ring.length = 0;
  ring.start = 0;
}

/** Push a stamp, overwriting the oldest when full. Mutates a slot in place. */
export function pushScratchMark(
  ring: ScratchMarksRing,
  u: number,
  v: number,
  radius: number,
): void {
  if (ring.length < ring.capacity) {
    const slot = ring.slots[ring.length]!;
    slot.u = u;
    slot.v = v;
    slot.radius = radius;
    ring.length += 1;
    return;
  }
  const slot = ring.slots[ring.start]!;
  slot.u = u;
  slot.v = v;
  slot.radius = radius;
  ring.start = (ring.start + 1) % ring.capacity;
}

export function scratchMarksSome(
  ring: ScratchMarksRing,
  pred: (mark: ScratchMark) => boolean,
): boolean {
  for (let i = 0; i < ring.length; i += 1) {
    const idx = (ring.start + i) % ring.capacity;
    if (pred(ring.slots[idx]!)) return true;
  }
  return false;
}
