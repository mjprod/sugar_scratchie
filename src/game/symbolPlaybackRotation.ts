/**
 * Hands playback turns to symbol icons a few at a time, in a loop.
 *
 * Up to eighteen symbol players can be on screen at once (six in the top bar,
 * twelve on the body) and each one is an independent WASM rasteriser, so
 * letting them all loop costs eighteen rasterisations per displayed frame for
 * as long as the card is open. Instead every player joins this rotation and
 * only animates when it holds a turn; the rest sit on their first frame, which
 * costs nothing. Motion is always present somewhere, but the bill is capped at
 * MAX_CONCURRENT_TURNS players regardless of how many symbols exist.
 */

// Raise this to trade CPU for liveliness: the cost is close to linear, and the
// wait between a given symbol's turns shrinks by the same factor.
const MAX_CONCURRENT_TURNS = 1;

// The longest symbol animation is ~4s. A turn holder normally returns its turn
// from its own completion event, but if that never arrives — a stalled worker,
// or a player torn down between frames — the rotation must not deadlock, so a
// turn is reclaimed once it has clearly overrun.
const TURN_TIMEOUT_MS = 7000;

type Entry = {
  ready: boolean;
  playing: boolean;
  timer: number | null;
  onTurn: () => void;
};

export type SymbolTurn = {
  /** Whether this player currently wants turns (revealed, not held still). */
  setReady(ready: boolean): void;
  /** Report that the turn's animation finished, passing it on. */
  finish(): void;
  /** Leave the rotation. */
  dispose(): void;
};

const rotation: Entry[] = [];
let cursor = 0;
let pumping = false;

function playingCount() {
  let count = 0;
  for (const entry of rotation) if (entry.playing) count += 1;
  return count;
}

function endTurn(entry: Entry) {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!entry.playing) return false;
  entry.playing = false;
  return true;
}

function pump() {
  // onTurn drives a player, which can synchronously report back; without this
  // the reentrant pump would hand out the same slot twice.
  if (pumping) return;
  pumping = true;
  try {
    let scanned = 0;
    while (rotation.length > 0 && playingCount() < MAX_CONCURRENT_TURNS) {
      if (scanned >= rotation.length) break;
      const entry = rotation[cursor];
      cursor = (cursor + 1) % rotation.length;
      scanned += 1;
      if (!entry.ready || entry.playing) continue;
      entry.playing = true;
      entry.timer = window.setTimeout(() => {
        if (endTurn(entry)) pump();
      }, TURN_TIMEOUT_MS);
      entry.onTurn();
      // A turn was granted, so any remaining slot deserves a fresh full sweep.
      scanned = 0;
    }
  } finally {
    pumping = false;
  }
}

export function joinSymbolRotation(onTurn: () => void): SymbolTurn {
  const entry: Entry = { ready: false, playing: false, timer: null, onTurn };
  rotation.push(entry);
  return {
    setReady(ready) {
      if (entry.ready === ready) return;
      entry.ready = ready;
      if (!ready) endTurn(entry);
      pump();
    },
    finish() {
      if (endTurn(entry)) pump();
    },
    dispose() {
      endTurn(entry);
      const index = rotation.indexOf(entry);
      if (index === -1) return;
      rotation.splice(index, 1);
      // Keep the cursor pointing at the same upcoming player rather than
      // letting a removal silently skip or repeat one.
      if (rotation.length === 0) cursor = 0;
      else if (index < cursor) cursor = (cursor - 1 + rotation.length) % rotation.length;
      else cursor %= rotation.length;
      pump();
    },
  };
}

/** Snapshot for `?debug=1` / stress probes — cheap to poll. */
export function getSymbolRotationStats() {
  let ready = 0;
  let playing = 0;
  for (const entry of rotation) {
    if (entry.ready) ready += 1;
    if (entry.playing) playing += 1;
  }
  return {
    total: rotation.length,
    ready,
    playing,
    maxConcurrent: MAX_CONCURRENT_TURNS,
  };
}
