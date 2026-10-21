/**
 * One-shot gate for decorative Lotties on the first-load path (nav icons).
 * Opens after the page has loaded and gone idle, or on the first user
 * interaction — whichever comes first — so the dotlottie wasm never competes
 * with LCP. Once open it stays open.
 */
export type LottieGateEnv = {
  /** Call `onLoaded` once the document has finished loading. */
  whenLoaded: (onLoaded: () => void) => () => void;
  /** Call `onIdle` once the main thread is idle. */
  whenIdle: (onIdle: () => void) => () => void;
  /** Call `onInteract` on the first pointer / key interaction. */
  onFirstInteraction: (onInteract: () => void) => () => void;
};

export type LottieGate = {
  isOpen: () => boolean;
  open: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createLottieGate(env: LottieGateEnv): LottieGate {
  let opened = false;
  const listeners = new Set<() => void>();
  const cleanups: Array<() => void> = [];

  const open = () => {
    if (opened) return;
    opened = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const listener of [...listeners]) listener();
  };

  cleanups.push(env.onFirstInteraction(open));
  cleanups.push(
    env.whenLoaded(() => {
      if (!opened) cleanups.push(env.whenIdle(open));
    }),
  );

  return {
    isOpen: () => opened,
    open,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
